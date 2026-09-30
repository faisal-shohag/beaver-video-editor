//! Import-time media work: probing, preview proxies, filmstrip thumbnails, waveforms.
use crate::ffmpeg::{self, probe, secs};
use crate::model::MediaInfo;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    path: String,
    info: Option<MediaInfo>,
    error: Option<String>,
}

#[tauri::command]
pub async fn probe_media(paths: Vec<String>) -> Vec<ProbeResult> {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::scope(|scope| {
            let handles: Vec<_> = paths.iter().map(|p| scope.spawn(move || (p.clone(), probe::probe(p)))).collect();
            handles
                .into_iter()
                .map(|h| {
                    let (path, r) = h.join().unwrap_or_else(|_| (String::new(), Err("probe crashed".into())));
                    match r {
                        Ok(info) => ProbeResult { path, info: Some(info), error: None },
                        Err(e) => ProbeResult { path, info: None, error: Some(e) },
                    }
                })
                .collect()
        })
    })
    .await
    .unwrap_or_default()
}

/// Stable 64-bit FNV-1a, used for cache keys.
fn fnv(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Cache key that changes when the file is replaced or edited.
fn cache_key(path: &str) -> String {
    let meta = std::fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{:016x}", fnv(format!("{path}|{size}|{mtime}").as_bytes()))
}

pub fn cache_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// Codecs WebView2 (Chromium) decodes natively on Windows.
fn browser_video_ok(codec: &str) -> bool {
    matches!(codec, "h264" | "hevc" | "vp8" | "vp9" | "av1")
}

fn browser_audio_ok(codec: &str) -> bool {
    matches!(codec, "aac" | "mp3" | "opus" | "vorbis" | "flac" | "pcm_s16le" | "pcm_f32le" | "pcm_s24le" | "")
}

fn browser_container_ok(format: &str) -> bool {
    ["mov", "mp4", "matroska", "webm", "mp3", "wav", "ogg", "flac", "aac"]
        .iter()
        .any(|f| format.split(',').any(|x| x == *f))
}

/// Whether preview should use a lightweight proxy instead of the original.
pub fn needs_proxy(info: &MediaInfo) -> bool {
    if !browser_container_ok(&info.format_name) || !browser_audio_ok(&info.acodec) {
        return true;
    }
    if info.has_video {
        // Keep the iGPU decoder and RAM light: anything above 1080p gets a proxy.
        return !browser_video_ok(&info.vcodec)
            || info.height.min(info.width) > 1080
            || info.pix_fmt.contains("422")
            || info.pix_fmt.contains("444")
            || info.fps > 61.0;
    }
    false
}

#[tauri::command]
pub fn check_needs_proxy(info: MediaInfo) -> bool {
    needs_proxy(&info)
}

#[tauri::command]
pub async fn generate_proxy(app: AppHandle, info: MediaInfo) -> Result<String, String> {
    let dir = cache_dir(&app, "proxies")?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&info.path);
        let ext = if info.has_video { "mp4" } else { "m4a" };
        let out = dir.join(format!("{key}.{ext}"));
        if out.exists() {
            return Ok(path_str(&out));
        }
        let tmp = dir.join(format!("{key}.part.{ext}"));
        let mut args: Vec<String> = vec!["-loglevel".into(), "error".into(), "-i".into(), info.path.clone()];
        if info.has_video {
            // Short GOP (10 frames) = instant scrubbing; ultrafast x264 runs 100+ fps on 4K here.
            args.extend(
                [
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0?",
                    "-vf",
                    "scale=w=960:h=960:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-tune",
                    "fastdecode",
                    "-crf",
                    "26",
                    "-g",
                    "10",
                    "-bf",
                    "0",
                ]
                .map(String::from),
            );
        } else {
            args.extend(["-map", "0:a:0", "-vn"].map(String::from));
        }
        args.extend(["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-y"].map(String::from));
        args.push(path_str(&tmp));
        ffmpeg::run_ffmpeg(&args)?;
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        Ok(path_str(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnails {
    path: String,
    count: u32,
    tile_width: u32,
    tile_height: u32,
}

/// One JPEG sprite with `count` evenly spaced frames laid out horizontally.
#[tauri::command]
pub async fn generate_thumbnails(app: AppHandle, info: MediaInfo) -> Result<Thumbnails, String> {
    let dir = cache_dir(&app, "thumbs")?;
    tauri::async_runtime::spawn_blocking(move || {
        let tile_h = 72u32;
        let aspect = if info.height > 0 { info.width as f64 / info.height as f64 } else { 16.0 / 9.0 };
        let tile_w = ((tile_h as f64 * aspect / 2.0).round() as u32 * 2).clamp(32, 256);
        // Roughly one frame per 2s, bounded so the sprite stays small.
        let count = ((info.duration / 2.0).ceil() as u32).clamp(4, 120);
        let key = cache_key(&info.path);
        let out = dir.join(format!("{key}_{count}_v2.jpg"));
        if !out.exists() {
            let interval = info.duration / count as f64;
            // Decoding only keyframes makes this ~20x faster than a full decode. `tpad` clones
            // the last keyframe so sparse-GOP files still fill every tile; MJPEG needs full range.
            let vf = format!(
                "tpad=stop_mode=clone:stop_duration={pad},fps=1/{iv},scale={tile_w}:{tile_h}:force_original_aspect_ratio=increase,crop={tile_w}:{tile_h},tile={count}x1,format=yuvj420p",
                pad = secs(info.duration),
                iv = secs(interval.max(0.04))
            );
            let args: Vec<String> = vec![
                "-loglevel".into(),
                "error".into(),
                "-skip_frame".into(),
                "nokey".into(),
                "-i".into(),
                info.path.clone(),
                "-an".into(),
                "-vf".into(),
                vf,
                "-fps_mode".into(),
                "passthrough".into(),
                "-frames:v".into(),
                "1".into(),
                "-q:v".into(),
                "5".into(),
                "-y".into(),
                path_str(&out),
            ];
            ffmpeg::run_ffmpeg(&args)?;
        }
        Ok(Thumbnails { path: path_str(&out), count, tile_width: tile_w, tile_height: tile_h })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub const WAVEFORM_PEAKS_PER_SEC: u32 = 50;

/// Peak amplitude envelope (0-255), `WAVEFORM_PEAKS_PER_SEC` values per second.
#[tauri::command]
pub async fn generate_waveform(app: AppHandle, path: String) -> Result<Vec<u8>, String> {
    let dir = cache_dir(&app, "waveforms")?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&path);
        let out = dir.join(format!("{key}.peaks"));
        if let Ok(bytes) = std::fs::read(&out) {
            return Ok(bytes);
        }
        let rate = 8000u32;
        let mut child = ffmpeg::ffmpeg()
            .args(["-loglevel", "error", "-i", &path, "-vn", "-ac", "1", "-ar", &rate.to_string(), "-f", "s16le", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let per_peak = (rate / WAVEFORM_PEAKS_PER_SEC) as usize;
        let mut peaks = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut carry: Option<u8> = None;
        let (mut count, mut max) = (0usize, 0i32);
        loop {
            let n = stdout.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            let mut i = 0;
            let mut sample = |lo: u8, hi: u8| {
                let v = i16::from_le_bytes([lo, hi]) as i32;
                max = max.max(v.abs());
                count += 1;
                if count == per_peak {
                    peaks.push(((max as f64 / 32768.0).sqrt() * 255.0).min(255.0) as u8);
                    count = 0;
                    max = 0;
                }
            };
            if let Some(lo) = carry.take() {
                sample(lo, buf[0]);
                i = 1;
            }
            while i + 1 < n {
                sample(buf[i], buf[i + 1]);
                i += 2;
            }
            if i < n {
                carry = Some(buf[i]);
            }
        }
        let _ = child.wait();
        if count > 0 {
            peaks.push(((max as f64 / 32768.0).sqrt() * 255.0).min(255.0) as u8);
        }
        let _ = std::fs::write(&out, &peaks);
        Ok(peaks)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(vcodec: &str, h: u32, format: &str) -> MediaInfo {
        MediaInfo {
            path: "x".into(),
            name: "x".into(),
            duration: 1.0,
            size_bytes: 1,
            format_name: format.into(),
            has_video: true,
            has_audio: true,
            width: h * 16 / 9,
            height: h,
            fps: 30.0,
            vcodec: vcodec.into(),
            pix_fmt: "yuv420p".into(),
            acodec: "aac".into(),
            sample_rate: 48000,
            channels: 2,
            rotation: 0,
        }
    }

    #[test]
    fn proxy_policy() {
        assert!(!needs_proxy(&info("h264", 1080, "mov,mp4,m4a,3gp,3g2,mj2")));
        assert!(!needs_proxy(&info("hevc", 1080, "mov,mp4,m4a,3gp,3g2,mj2")));
        assert!(needs_proxy(&info("h264", 2160, "mov,mp4,m4a,3gp,3g2,mj2")));
        assert!(needs_proxy(&info("prores", 1080, "mov,mp4,m4a,3gp,3g2,mj2")));
        assert!(needs_proxy(&info("mpeg2video", 576, "mpegts")));
        let mut ac3 = info("h264", 720, "matroska,webm");
        ac3.acodec = "ac3".into();
        assert!(needs_proxy(&ac3));
    }
}
