//! "Enhance voice": renders a cleaned-up copy of a media file's audio with one of three models
//! chosen in bench/audio-enhance (DeepFilterNet3, DPDFNet-2 48k, Sidon). Results are cached per
//! (media file, model, strength) and shared by every clip cut from that media.
pub mod dfn3;
pub mod dpdfnet;
pub mod dsp;
pub mod models;
pub mod onnx;
pub mod sidon;
#[cfg(test)]
pub mod testutil;

use crate::commands::media::{cache_dir, cache_key};
use crate::jobs::{self, run_ffmpeg_tracked, JobHandle, Jobs, Reporter};
use crate::model::{EnhanceModel, EnhanceStrength};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

/// Cache file for an enhancement. Sidon has no strength setting, so it always uses "full".
pub fn cached_path(
    app: &AppHandle,
    media_path: &str,
    model: EnhanceModel,
    strength: EnhanceStrength,
) -> Result<PathBuf, String> {
    let strength = if model == EnhanceModel::Sidon { EnhanceStrength::Full } else { strength };
    let s = serde_json::to_value(strength).map_err(|e| e.to_string())?;
    let s = s.as_str().unwrap_or("full");
    Ok(cache_dir(app, "enhanced")?.join(format!("{}_{}_{s}.wav", cache_key(media_path), model.id())))
}

/// Decode a media file's audio to mono f32 at `rate` (cancellable via the job).
pub fn decode(media: &str, rate: u32, dir: &Path, job: &JobHandle) -> Result<Vec<f32>, String> {
    let raw = dir.join("audio.f32");
    let args: Vec<String> =
        ["-loglevel", "error", "-i", media, "-vn", "-ac", "1", "-ar", &rate.to_string(), "-f", "f32le"]
            .iter()
            .map(|s| s.to_string())
            .chain(["-progress".into(), "pipe:1".into(), "-nostats".into(), "-y".into(), raw.to_string_lossy().into()])
            .collect();
    run_ffmpeg_tracked(&args, job, |_| {})?;
    let bytes = std::fs::read(&raw).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&raw);
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

pub fn write_wav(path: &Path, rate: u32, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for s in samples {
        w.write_sample(s.clamp(-1.0, 1.0)).map_err(|e| e.to_string())?;
    }
    w.finalize().map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnhanceDone {
    job_id: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    path: Option<String>,
    media_path: String,
    model: EnhanceModel,
    strength: EnhanceStrength,
    elapsed_secs: f64,
}

/// One enhancement request (a media file rendered with a model/strength).
struct Request {
    media: String,
    duration: f64,
    model: EnhanceModel,
    strength: EnhanceStrength,
}

fn render(app: &AppHandle, job: &JobHandle, rep: &Reporter, job_id: &str, req: &Request) -> Result<PathBuf, String> {
    let Request { media, duration, model, strength } = req;
    let (media, duration, model, strength) = (media.as_str(), *duration, *model, *strength);
    let out = cached_path(app, media, model, strength)?;
    if out.exists() {
        return Ok(out);
    }
    let spec = models::spec(model);
    if !models::installed(app, spec) {
        return Err("This model isn't downloaded yet".into());
    }
    let dir = cache_dir(app, "enhance-tmp")?.join(job_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = out.with_extension("part.wav");
    let result = (|| {
        rep.stage(0.0, "Reading audio");
        match model {
            EnhanceModel::Dfn3 => {
                let input = dir.join("input.wav");
                let args: Vec<String> =
                    ["-loglevel", "error", "-i", media, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le"]
                        .iter()
                        .map(|s| s.to_string())
                        .chain(["-progress".into(), "pipe:1".into(), "-nostats".into(), "-y".into()])
                        .chain([input.to_string_lossy().to_string()])
                        .collect();
                run_ffmpeg_tracked(&args, job, |_| {})?;
                let tick = Reporter::new(app, "enhance", job_id);
                let produced =
                    dfn3::enhance_file(&input, &dir.join("out"), duration, strength.atten_limit_db(), job, move |p| {
                        tick.stage(0.05 + 0.95 * p, "Enhancing")
                    })?;
                std::fs::rename(produced, &part).map_err(|e| e.to_string())
            }
            EnhanceModel::Dpdfnet2 => {
                let audio = decode(media, 48_000, &dir, job)?;
                let path = models::file_path(app, &spec.files[0])?;
                let atten = (strength != EnhanceStrength::Full).then(|| strength.atten_limit_db());
                let y = dpdfnet::enhance(&path, &audio, atten, |p| {
                    rep.stage(0.05 + 0.95 * p, "Enhancing");
                    job.check()
                })?;
                write_wav(&part, 48_000, &y)
            }
            EnhanceModel::Sidon => {
                let audio = decode(media, 16_000, &dir, job)?;
                let pred = models::file_path(app, &spec.files[0])?;
                let voc = models::file_path(app, &spec.files[1])?;
                let y = sidon::enhance(&pred, &voc, &audio, 0, |p| {
                    rep.stage(0.05 + 0.95 * p, "Restoring");
                    job.check()
                })?;
                write_wav(&part, 48_000, &y)
            }
        }
    })();
    let _ = std::fs::remove_dir_all(&dir);
    match result {
        Ok(()) => {
            std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
            Ok(out)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Start enhancing `media_path`; emits `enhance://progress` and `enhance://done`.
#[tauri::command]
pub fn start_enhance(
    app: AppHandle,
    state: State<'_, Jobs>,
    job_id: String,
    media_path: String,
    duration: f64,
    model: EnhanceModel,
    strength: EnhanceStrength,
) -> Result<(), String> {
    let job = state.register(&job_id);
    std::thread::spawn(move || {
        let rep = Reporter::new(&app, "enhance", &job_id);
        let req = Request { media: media_path.clone(), duration, model, strength };
        let result = render(&app, &job, &rep, &job_id, &req);
        let cancelled = matches!(&result, Err(e) if e == "cancelled");
        let _ = app.emit(
            "enhance://done",
            EnhanceDone {
                job_id: job_id.clone(),
                ok: result.is_ok(),
                cancelled,
                path: result.as_ref().ok().map(|p| p.to_string_lossy().to_string()),
                error: result.err().filter(|_| !cancelled),
                media_path,
                model,
                strength,
                elapsed_secs: rep.started.elapsed().as_secs_f64(),
            },
        );
        jobs::unregister(&app, &job_id);
    });
    Ok(())
}

/// Path of an already-rendered enhancement, if cached (used when reopening projects).
#[tauri::command]
pub fn enhanced_path(
    app: AppHandle,
    media_path: String,
    model: EnhanceModel,
    strength: EnhanceStrength,
) -> Option<String> {
    let p = cached_path(&app, &media_path, model, strength).ok()?;
    p.exists().then(|| p.to_string_lossy().to_string())
}
