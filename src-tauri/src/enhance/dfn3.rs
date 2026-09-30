//! DeepFilterNet3 (MIT/Apache-2.0) via the official `deep-filter` binary, bundled as a sidecar.
use crate::ffmpeg;
use crate::jobs::{run_child, JobHandle};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Measured real-time factor on the reference machine (used for the progress estimate).
const RTF: f64 = 0.045;

pub fn binary() -> PathBuf {
    ffmpeg::resolve("deep-filter")
}

/// Enhance a 48 kHz WAV file into `out_dir/<same name>`. The CLI reports no progress, so it's
/// estimated from elapsed time and the measured speed.
pub fn enhance_file(
    input: &Path,
    out_dir: &Path,
    duration: f64,
    atten_limit_db: f32,
    job: &JobHandle,
    progress: impl Fn(f64) + Send + 'static,
) -> Result<PathBuf, String> {
    let mut cmd = ffmpeg::hidden(std::process::Command::new(binary()));
    // -D compensates the STFT/model delay so output lines up with the video.
    cmd.args(["-D", "-a", &format!("{atten_limit_db}"), "-o"]).arg(out_dir).arg(input);
    let done = Arc::new(AtomicBool::new(false));
    let ticker = {
        let done = done.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let expected = (duration * RTF).max(0.5);
            while !done.load(Ordering::Relaxed) {
                progress((started.elapsed().as_secs_f64() / expected).min(0.95));
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        })
    };
    let result = run_child(cmd, job, |_| {});
    done.store(true, Ordering::Relaxed);
    let _ = ticker.join();
    result?;
    let out = out_dir.join(input.file_name().ok_or("bad input name")?);
    if out.exists() {
        Ok(out)
    } else {
        Err("deep-filter produced no output".into())
    }
}
