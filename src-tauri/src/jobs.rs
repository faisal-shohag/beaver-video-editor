//! Long-running background jobs (exports, voice enhancement, model downloads):
//! cancellation, child-process tracking and throttled progress events.
use crate::ffmpeg::progress::{ProgressParser, ProgressSample};
use crate::ffmpeg::{self, last_lines};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Default)]
pub struct JobHandle {
    cancelled: Arc<AtomicBool>,
    children: Arc<Mutex<Vec<Child>>>,
}

impl JobHandle {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        for c in self.children.lock().unwrap().iter_mut() {
            let _ = c.kill();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// `Err("cancelled")` once the job was cancelled; for long in-process loops.
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
pub struct Jobs {
    jobs: Mutex<HashMap<String, JobHandle>>,
}

impl Jobs {
    pub fn register(&self, job_id: &str) -> JobHandle {
        let h = JobHandle::default();
        self.jobs.lock().unwrap().insert(job_id.to_string(), h.clone());
        h
    }

    pub fn remove(&self, job_id: &str) {
        self.jobs.lock().unwrap().remove(job_id);
    }
}

pub fn unregister(app: &AppHandle, job_id: &str) {
    app.state::<Jobs>().remove(job_id);
}

#[tauri::command]
pub fn cancel_job(state: State<'_, Jobs>, job_id: String) {
    if let Some(j) = state.jobs.lock().unwrap().get(&job_id) {
        j.cancel();
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    job_id: String,
    /// 0..1
    progress: f64,
    fps: f64,
    speed: f64,
    eta_secs: f64,
    stage: String,
}

/// Emits `<channel>://progress` events, throttled to 10 per second.
pub struct Reporter {
    app: AppHandle,
    channel: &'static str,
    job_id: String,
    pub started: Instant,
    last_emit: Mutex<Instant>,
}

impl Reporter {
    pub fn new(app: &AppHandle, channel: &'static str, job_id: &str) -> Self {
        Reporter {
            app: app.clone(),
            channel,
            job_id: job_id.to_string(),
            started: Instant::now(),
            // Backdated so the first event is never throttled away.
            last_emit: Mutex::new(Instant::now() - std::time::Duration::from_secs(1)),
        }
    }

    pub fn emit(&self, progress: f64, fps: f64, speed: f64, stage: &str, force: bool) {
        let mut last = self.last_emit.lock().unwrap();
        if !force && last.elapsed().as_millis() < 100 {
            return;
        }
        *last = Instant::now();
        let elapsed = self.started.elapsed().as_secs_f64();
        let p = progress.clamp(0.0, 1.0);
        let eta = if p > 0.01 { elapsed / p - elapsed } else { -1.0 };
        let _ = self.app.emit(
            &format!("{}://progress", self.channel),
            ProgressEvent { job_id: self.job_id.clone(), progress: p, fps, speed, eta_secs: eta, stage: stage.into() },
        );
    }

    /// Simple progress without fps/speed.
    pub fn stage(&self, progress: f64, stage: &str) {
        self.emit(progress, 0.0, 0.0, stage, false);
    }
}

/// Run `cmd` to completion, handing each stdout line to `on_line`. The child is registered so
/// `cancel()` can kill it. Returns the last stderr lines on failure.
pub fn run_child(mut cmd: Command, job: &JobHandle, mut on_line: impl FnMut(&str)) -> Result<(), String> {
    job.check()?;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start {:?}: {e}", cmd.get_program()))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let pid = child.id();
    job.children.lock().unwrap().push(child);
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        on_line(&line);
    }
    let status = {
        let mut children = job.children.lock().unwrap();
        match children.iter().position(|c| c.id() == pid) {
            Some(i) => children.remove(i).wait().map_err(|e| e.to_string())?,
            None => return Err("process lost".into()),
        }
    };
    let stderr_text = err_thread.join().unwrap_or_default();
    job.check()?;
    if status.success() {
        Ok(())
    } else {
        let msg = last_lines(&stderr_text, 6);
        Err(if msg.is_empty() { format!("process exited with {status}") } else { msg })
    }
}

/// Run FFmpeg, streaming its `-progress pipe:1` samples to `on_progress`.
pub fn run_ffmpeg_tracked(
    args: &[String],
    job: &JobHandle,
    mut on_progress: impl FnMut(&ProgressSample),
) -> Result<(), String> {
    let mut cmd = ffmpeg::ffmpeg();
    cmd.args(args);
    let mut parser = ProgressParser::default();
    run_child(cmd, job, |line| {
        if let Some(sample) = parser.feed(line) {
            on_progress(&sample);
        }
    })
}
