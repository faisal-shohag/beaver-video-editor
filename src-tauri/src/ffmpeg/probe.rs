//! ffprobe wrapper producing `MediaInfo`.
use crate::model::MediaInfo;
use serde_json::Value;
use std::path::Path;

pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let out = super::ffprobe()
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("failed to start ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(format!("Cannot read media: {}", super::last_lines(&String::from_utf8_lossy(&out.stderr), 2)));
    }
    let json: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    parse(path, size, &json)
}

/// Video keyframe timestamps (keyframe-only decode, fast even for long files).
pub fn keyframes(path: &str) -> Result<Vec<f64>, String> {
    let out = super::ffprobe()
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let mut k: Vec<f64> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().trim_end_matches(',').parse().ok())
        .collect();
    k.sort_by(f64::total_cmp);
    Ok(k)
}

/// Last keyframe at or before `t` (0 if none).
pub fn keyframe_at_or_before(keys: &[f64], t: f64) -> f64 {
    keys.iter().copied().filter(|k| *k <= t + 1e-3).fold(0.0, f64::max)
}

fn parse_rate(s: &str) -> f64 {
    match s.split_once('/') {
        Some((n, d)) => {
            let n: f64 = n.parse().unwrap_or(0.0);
            let d: f64 = d.parse().unwrap_or(0.0);
            if d > 0.0 {
                n / d
            } else {
                0.0
            }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

fn num_field(v: &Value, key: &str) -> f64 {
    match &v[key] {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn rotation(stream: &Value) -> i32 {
    if let Some(list) = stream["side_data_list"].as_array() {
        for sd in list {
            if let Some(r) = sd["rotation"].as_f64() {
                return r.round() as i32;
            }
        }
    }
    stream["tags"]["rotate"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
}

pub fn parse(path: &str, size: u64, json: &Value) -> Result<MediaInfo, String> {
    let empty = vec![];
    let streams = json["streams"].as_array().unwrap_or(&empty);
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 0);
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    if video.is_none() && audio.is_none() {
        return Err("File has no video or audio stream".into());
    }

    let mut duration = num_field(&json["format"], "duration");
    if duration <= 0.0 {
        duration = [video, audio].iter().flatten().map(|s| num_field(s, "duration")).fold(0.0, f64::max);
    }
    if duration <= 0.0 {
        return Err("Could not determine media duration".into());
    }

    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());

    let mut info = MediaInfo {
        path: path.to_string(),
        name,
        duration,
        size_bytes: size,
        format_name: json["format"]["format_name"].as_str().unwrap_or("").to_string(),
        has_video: video.is_some(),
        has_audio: audio.is_some(),
        width: 0,
        height: 0,
        fps: 0.0,
        vcodec: String::new(),
        pix_fmt: String::new(),
        acodec: String::new(),
        sample_rate: 0,
        channels: 0,
        rotation: 0,
    };

    if let Some(v) = video {
        let (w, h) = (v["width"].as_u64().unwrap_or(0) as u32, v["height"].as_u64().unwrap_or(0) as u32);
        let rot = rotation(v);
        // FFmpeg auto-rotates on decode, so report display dimensions.
        let (w, h) = if rot.rem_euclid(180) == 90 { (h, w) } else { (w, h) };
        info.width = w;
        info.height = h;
        info.rotation = rot;
        let mut fps = parse_rate(v["avg_frame_rate"].as_str().unwrap_or("0/0"));
        if !(1.0..=240.0).contains(&fps) {
            fps = parse_rate(v["r_frame_rate"].as_str().unwrap_or("0/0"));
        }
        info.fps = if (1.0..=240.0).contains(&fps) { fps } else { 30.0 };
        info.vcodec = v["codec_name"].as_str().unwrap_or("").to_string();
        info.pix_fmt = v["pix_fmt"].as_str().unwrap_or("").to_string();
    }
    if let Some(a) = audio {
        info.acodec = a["codec_name"].as_str().unwrap_or("").to_string();
        info.sample_rate = num_field(a, "sample_rate") as u32;
        info.channels = a["channels"].as_u64().unwrap_or(0) as u32;
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_rotated_phone_video() {
        let j = json!({
            "format": {"duration": "12.5", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
            "streams": [
                {"codec_type": "video", "codec_name": "hevc", "width": 1920, "height": 1080,
                 "avg_frame_rate": "30000/1001", "pix_fmt": "yuv420p10le",
                 "side_data_list": [{"rotation": -90}], "disposition": {"attached_pic": 0}},
                {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2}
            ]
        });
        let m = parse("C:/v/clip.mov", 100, &j).unwrap();
        assert_eq!((m.width, m.height), (1080, 1920));
        assert!((m.fps - 29.97).abs() < 0.01);
        assert_eq!(m.name, "clip.mov");
        assert_eq!(m.sample_rate, 48000);
        assert!(m.has_audio && m.has_video);
    }

    #[test]
    fn mp3_cover_art_is_not_video() {
        let j = json!({
            "format": {"duration": "180.0", "format_name": "mp3"},
            "streams": [
                {"codec_type": "audio", "codec_name": "mp3", "sample_rate": "44100", "channels": 2},
                {"codec_type": "video", "codec_name": "mjpeg", "width": 500, "height": 500,
                 "disposition": {"attached_pic": 1}}
            ]
        });
        let m = parse("song.mp3", 1, &j).unwrap();
        assert!(!m.has_video);
        assert!(m.has_audio);
    }
}
