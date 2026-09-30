//! Encoder discovery + self-benchmark. Results are cached so it runs once per install.
use crate::ffmpeg;
use crate::model::VideoCodec;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

const BENCH_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderResult {
    pub codec: VideoCodec,
    pub encoder: String,
    pub hardware: bool,
    pub ok: bool,
    /// Frames per second on a noisy 1080p test clip (0 if failed).
    pub fps: f64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderReport {
    pub version: u32,
    pub ffmpeg_version: String,
    pub results: Vec<EncoderResult>,
    /// Fastest working encoder per codec.
    pub best: HashMap<VideoCodec, String>,
}

impl EncoderReport {
    pub fn fastest_hardware(&self, codec: VideoCodec) -> Option<&EncoderResult> {
        self.results.iter().filter(|r| r.codec == codec && r.ok && r.hardware).max_by(|a, b| a.fps.total_cmp(&b.fps))
    }
    pub fn fastest_software(&self, codec: VideoCodec) -> Option<&EncoderResult> {
        self.results.iter().filter(|r| r.codec == codec && r.ok && !r.hardware).max_by(|a, b| a.fps.total_cmp(&b.fps))
    }
}

#[derive(Default)]
pub struct EncoderState(pub Mutex<Option<EncoderReport>>);

pub fn candidates() -> Vec<(VideoCodec, &'static str, bool)> {
    use VideoCodec::*;
    vec![
        (H264, "libx264", false),
        (H264, "h264_amf", true),
        (H264, "h264_nvenc", true),
        (H264, "h264_qsv", true),
        (Hevc, "libx265", false),
        (Hevc, "hevc_amf", true),
        (Hevc, "hevc_nvenc", true),
        (Hevc, "hevc_qsv", true),
        (Av1, "libsvtav1", false),
        (Av1, "av1_amf", true),
        (Av1, "av1_nvenc", true),
        (Av1, "av1_qsv", true),
        (Vp9, "libvpx-vp9", false),
        (Prores, "prores_ks", false),
    ]
}

/// Software fallback when nothing has been benchmarked yet.
pub fn default_encoder(codec: VideoCodec) -> &'static str {
    match codec {
        VideoCodec::H264 => "libx264",
        VideoCodec::Hevc => "libx265",
        VideoCodec::Av1 => "libsvtav1",
        VideoCodec::Vp9 => "libvpx-vp9",
        VideoCodec::Prores => "prores_ks",
    }
}

fn available_encoders() -> String {
    ffmpeg::ffmpeg()
        .args(["-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

fn ffmpeg_version() -> String {
    ffmpeg::ffmpeg()
        .arg("-version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|l| l.to_string()))
        .unwrap_or_else(|| "ffmpeg not found".into())
}

/// Noisy 1080p clip approximating camera footage (clean test patterns flatter CPU
/// encoders). Rendered once so the benchmark measures encoding, not source generation.
fn bench_source() -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join("beaver-bench-1080p.mkv");
    if !path.exists() {
        let tmp = std::env::temp_dir().join("beaver-bench-1080p.part.mkv");
        let args: Vec<String> = [
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30:duration=2,noise=alls=10:allf=t",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-qp",
            "12",
            "-pix_fmt",
            "yuv420p",
            "-y",
        ]
        .map(String::from)
        .to_vec()
        .into_iter()
        .chain([tmp.to_string_lossy().to_string()])
        .collect();
        ffmpeg::run_ffmpeg(&args)?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn bench_one(source: &str, codec: VideoCodec, encoder: &str) -> (bool, f64, Option<String>) {
    let frames = 60.0;
    let mut args: Vec<String> = ["-loglevel", "error", "-i", source, "-c:v", encoder].map(String::from).to_vec();
    // Same "balanced" settings the exporter uses, so rankings reflect real exports.
    match encoder {
        "libx264" => args.extend(["-preset", "faster", "-crf", "22"].map(String::from)),
        "libx265" => {
            args.extend(["-preset", "fast", "-crf", "25", "-x265-params", "log-level=error"].map(String::from))
        }
        "libsvtav1" => args.extend(["-preset", "8", "-crf", "32"].map(String::from)),
        "libvpx-vp9" => args.extend(["-deadline", "good", "-cpu-used", "4", "-row-mt", "1"].map(String::from)),
        e if e.ends_with("_amf") => args.extend(["-quality", "balanced"].map(String::from)),
        _ => {}
    }
    let pix = crate::ffmpeg::graph::pixel_format(codec, encoder);
    args.extend(["-pix_fmt", pix, "-f", "null", "-"].map(String::from));
    let start = Instant::now();
    match ffmpeg::run_ffmpeg(&args) {
        Ok(()) => (true, frames / start.elapsed().as_secs_f64().max(0.001), None),
        Err(e) => (false, 0.0, Some(e.lines().next().unwrap_or("").to_string())),
    }
}

pub fn run_benchmark() -> EncoderReport {
    let listing = available_encoders();
    let source_path = bench_source();
    let source = source_path.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let mut results = vec![];
    for (codec, name, hw) in candidates() {
        let present = listing.lines().any(|l| l.split_whitespace().nth(1) == Some(name));
        if !present {
            continue;
        }
        let (ok, fps, error) = bench_one(&source, codec, name);
        results.push(EncoderResult { codec, encoder: name.to_string(), hardware: hw, ok, fps, error });
    }
    if let Ok(p) = source_path {
        let _ = std::fs::remove_file(p);
    }
    let mut best: HashMap<VideoCodec, String> = HashMap::new();
    for r in results.iter().filter(|r| r.ok) {
        let current = best.get(&r.codec).and_then(|e| results.iter().find(|x| &x.encoder == e));
        if current.map(|c| r.fps > c.fps).unwrap_or(true) {
            best.insert(r.codec, r.encoder.clone());
        }
    }
    EncoderReport { version: BENCH_VERSION, ffmpeg_version: ffmpeg_version(), results, best }
}

fn cache_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("encoders.json"))
}

/// Cached report, or a fresh benchmark (≈5-10 s) when missing / `force`.
#[tauri::command]
pub async fn get_encoders(
    app: AppHandle,
    state: State<'_, EncoderState>,
    force: bool,
) -> Result<EncoderReport, String> {
    // One benchmark at a time; a second caller waits and then gets the cached result.
    static RUNNING: LazyLock<tauri::async_runtime::Mutex<()>> = LazyLock::new(Default::default);
    let _guard = RUNNING.lock().await;
    if !force {
        if let Some(r) = state.0.lock().unwrap().clone() {
            return Ok(r);
        }
        if let Some(r) = cache_file(&app)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<EncoderReport>(&b).ok())
            .filter(|r| r.version == BENCH_VERSION && r.ffmpeg_version == ffmpeg_version())
        {
            *state.0.lock().unwrap() = Some(r.clone());
            return Ok(r);
        }
    }
    let report = tauri::async_runtime::spawn_blocking(run_benchmark).await.map_err(|e| e.to_string())?;
    if let Some(p) = cache_file(&app) {
        let _ = std::fs::write(p, serde_json::to_vec_pretty(&report).unwrap_or_default());
    }
    *state.0.lock().unwrap() = Some(report.clone());
    Ok(report)
}
