//! Export jobs: render / lossless copy / turbo (parallel chunks) and quick join.
use super::encoders::{default_encoder, EncoderState};
use super::media::cache_dir;
use crate::ffmpeg::graph::{self, RenderSpec};
use crate::ffmpeg::progress::{ProgressParser, ProgressSample};
use crate::ffmpeg::{self, last_lines, probe};
use crate::model::*;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Default)]
struct JobHandle {
    cancelled: Arc<AtomicBool>,
    children: Arc<Mutex<Vec<Child>>>,
}

impl JobHandle {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        for c in self.children.lock().unwrap().iter_mut() {
            let _ = c.kill();
        }
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
pub struct ExportState {
    jobs: Mutex<HashMap<String, JobHandle>>,
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    job_id: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    output: String,
    elapsed_secs: f64,
    size_bytes: u64,
    encoder: String,
}

struct Reporter {
    app: AppHandle,
    job_id: String,
    started: Instant,
    last_emit: Mutex<Instant>,
}

impl Reporter {
    fn emit(&self, progress: f64, fps: f64, speed: f64, stage: &str, force: bool) {
        let mut last = self.last_emit.lock().unwrap();
        if !force && last.elapsed().as_millis() < 100 {
            return;
        }
        *last = Instant::now();
        let elapsed = self.started.elapsed().as_secs_f64();
        let p = progress.clamp(0.0, 1.0);
        let eta = if p > 0.01 { elapsed / p - elapsed } else { -1.0 };
        let _ = self.app.emit(
            "export://progress",
            ProgressEvent { job_id: self.job_id.clone(), progress: p, fps, speed, eta_secs: eta, stage: stage.into() },
        );
    }
}

/// Run FFmpeg, streaming `-progress` samples to `on_progress`. Child is registered for cancel.
fn run_tracked(args: &[String], job: &JobHandle, mut on_progress: impl FnMut(&ProgressSample)) -> Result<(), String> {
    if job.is_cancelled() {
        return Err("cancelled".into());
    }
    let mut child = ffmpeg::ffmpeg()
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let pid = child.id();
    job.children.lock().unwrap().push(child);
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let mut parser = ProgressParser::default();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(sample) = parser.feed(&line) {
            on_progress(&sample);
        }
    }
    let status = {
        let mut children = job.children.lock().unwrap();
        let idx = children.iter().position(|c| c.id() == pid);
        match idx {
            Some(i) => children.remove(i).wait().map_err(|e| e.to_string())?,
            None => return Err("process lost".into()),
        }
    };
    let stderr_text = err_thread.join().unwrap_or_default();
    if job.is_cancelled() {
        return Err("cancelled".into());
    }
    if status.success() {
        Ok(())
    } else {
        let msg = last_lines(&stderr_text, 6);
        Err(if msg.is_empty() { format!("ffmpeg exited with {status}") } else { msg })
    }
}

/// Pick the encoder. "Fastest" prefers the fastest measured hardware encoder (a single
/// GPU pass beat every CPU/GPU chunking scheme we measured); "Best compression" uses the
/// user's choice or the fastest software encoder, which gives smaller files.
fn resolve_encoder(app: &AppHandle, s: &ExportSettings) -> String {
    if s.encoder != "auto" && !s.encoder.is_empty() {
        return s.encoder.clone();
    }
    let state = app.state::<EncoderState>();
    let guard = state.0.lock().unwrap();
    let report = guard.as_ref();
    let hw = report.and_then(|r| r.fastest_hardware(s.video_codec)).map(|e| e.encoder.clone());
    let sw = report.and_then(|r| r.fastest_software(s.video_codec)).map(|e| e.encoder.clone());
    let picked = match s.mode {
        ExportMode::Turbo => hw.or(sw),
        _ => sw.or(hw),
    };
    picked.unwrap_or_else(|| default_encoder(s.video_codec).to_string())
}

fn write_filter(dir: &Path, name: &str, filter: &str) -> Result<String, String> {
    let p = dir.join(name);
    std::fs::write(&p, filter).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

fn job_dir(app: &AppHandle, job_id: &str) -> Result<PathBuf, String> {
    let d = cache_dir(app, "export-tmp")?.join(job_id);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn render_single(
    job: &JobHandle,
    rep: &Reporter,
    project: &Project,
    s: &ExportSettings,
    encoder: &str,
    dir: &Path,
) -> Result<(), String> {
    let range = graph::effective_range(project, s);
    let plan = graph::build_render(&RenderSpec {
        project,
        settings: s,
        encoder,
        range,
        include_video: true,
        include_audio: true,
        output: &s.output_path,
        format_override: None,
        threads: None,
    })?;
    let script = write_filter(dir, "graph.txt", &plan.filter)?;
    let dur = plan.duration;
    run_tracked(&plan.args(&script), job, |p| rep.emit(p.out_time / dur, p.fps, p.speed, "Rendering", p.done))
}

fn copy_export(
    job: &JobHandle,
    rep: &Reporter,
    project: &Project,
    s: &ExportSettings,
    dir: &Path,
) -> Result<(), String> {
    graph::copy_eligibility(project, s)?;
    let range = graph::effective_range(project, s);
    rep.emit(0.0, 0.0, 0.0, "Finding keyframes", true);
    let mut keys: HashMap<String, Vec<f64>> = HashMap::new();
    for m in &project.media {
        if project.clips.iter().any(|c| c.media_id == m.id) {
            keys.insert(m.id.clone(), probe::keyframes(&m.info.path)?);
        }
    }
    let snap = |m: &MediaItem, t: f64| keys.get(&m.id).map(|k| probe::keyframe_at_or_before(k, t)).unwrap_or(t);
    let segments = graph::copy_segments(project, range, &snap);
    let total: f64 = segments.iter().map(|g| g.duration).sum::<f64>().max(0.001);
    let mut files = vec![];
    let mut done = 0.0;
    for (i, seg) in segments.iter().enumerate() {
        let out = dir.join(format!("seg_{i:04}.mkv")).to_string_lossy().to_string();
        run_tracked(&graph::segment_args(seg, &out), job, |_| {})?;
        done += seg.duration;
        rep.emit(done / total * 0.9, 0.0, 0.0, "Cutting segments", false);
        files.push(out);
    }
    let list = dir.join("segments.ffconcat");
    std::fs::write(&list, graph::concat_files(&files)).map_err(|e| e.to_string())?;
    let args = graph::copy_args(&list.to_string_lossy(), s, &s.output_path);
    run_tracked(&args, job, |p| rep.emit(0.9 + p.out_time / total * 0.1, p.fps, p.speed, "Joining", p.done))
}

/// Encoders whose single-process throughput leaves most cores idle; chunking helps them.
fn scales_poorly(encoder: &str) -> bool {
    encoder == "libvpx-vp9"
}

/// Parallel chunked encode: video split into frame-aligned chunks encoded by several
/// FFmpeg processes, audio encoded once, then everything stitched with stream copy.
/// Only used for encoders that don't use all cores on their own (see `scales_poorly`).
fn turbo_export(
    job: &JobHandle,
    rep: &Reporter,
    project: &Project,
    s: &ExportSettings,
    encoder: &str,
    dir: &Path,
) -> Result<String, String> {
    let range = graph::effective_range(project, s);
    let fps = graph::output_fps(project, s);
    let dur = range.1 - range.0;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8) as u32;
    let n_workers: u32 = if cores >= 12 { 3 } else { 2 };
    let threads = (cores / n_workers).max(2);
    let workers: Vec<String> = (0..n_workers).map(|_| encoder.to_string()).collect();
    let (chunk_fmt, chunk_ext) = ("matroska", "mkv");
    // A few chunks per worker balances load without paying process start-up too often.
    let n_chunks = ((dur / 5.0).ceil() as usize).clamp(workers.len(), workers.len() * 2);
    let chunks = graph::chunk_ranges(range, n_chunks, fps);
    let queue: Mutex<VecDeque<(usize, (f64, f64))>> = Mutex::new(chunks.iter().copied().enumerate().collect());
    let done_secs: Mutex<Vec<f64>> = Mutex::new(vec![0.0; chunks.len()]);
    let first_err: Mutex<Option<String>> = Mutex::new(None);
    let chunk_path = |i: usize| dir.join(format!("chunk_{i:04}.{chunk_ext}"));

    // Audio: one pass over the whole range, in parallel with video chunks.
    let audio_path = dir.join("audio.mka");
    let has_audio_out = s.audio_codec != AudioCodec::None;

    std::thread::scope(|scope| {
        if has_audio_out {
            let audio_path = &audio_path;
            let first_err = &first_err;
            scope.spawn(move || {
                let res = graph::build_render(&RenderSpec {
                    project,
                    settings: s,
                    encoder,
                    range,
                    include_video: false,
                    include_audio: true,
                    output: &audio_path.to_string_lossy(),
                    format_override: Some("matroska"),
                    threads: None,
                })
                .and_then(|plan| {
                    let script = write_filter(dir, "audio_graph.txt", &plan.filter)?;
                    run_tracked(&plan.args(&script), job, |_| {})
                });
                if let Err(e) = res {
                    first_err.lock().unwrap().get_or_insert(e);
                    job.cancel();
                }
            });
        }
        for (wi, enc) in workers.iter().enumerate() {
            let queue = &queue;
            let done_secs = &done_secs;
            let first_err = &first_err;
            let chunk_path = &chunk_path;
            scope.spawn(move || loop {
                let Some((ci, r)) = queue.lock().unwrap().pop_front() else { break };
                let out = chunk_path(ci);
                let res = graph::build_render(&RenderSpec {
                    project,
                    settings: s,
                    encoder: enc,
                    range: r,
                    include_video: true,
                    include_audio: false,
                    output: &out.to_string_lossy(),
                    format_override: Some(chunk_fmt),
                    threads: Some(threads),
                })
                .and_then(|plan| {
                    let script = write_filter(dir, &format!("graph_{wi}_{ci}.txt"), &plan.filter)?;
                    run_tracked(&plan.args(&script), job, |p| {
                        let total: f64 = {
                            let mut d = done_secs.lock().unwrap();
                            d[ci] = p.out_time.min(r.1 - r.0);
                            d.iter().sum()
                        };
                        rep.emit(total / dur * 0.97, p.fps, 0.0, "Turbo encoding", false);
                    })
                });
                if let Err(e) = res {
                    first_err.lock().unwrap().get_or_insert(e);
                    job.cancel();
                    break;
                }
                done_secs.lock().unwrap()[ci] = r.1 - r.0;
            });
        }
    });

    if let Some(e) = first_err.into_inner().unwrap() {
        return Err(e);
    }
    if job.is_cancelled() {
        return Err("cancelled".into());
    }

    rep.emit(0.98, 0.0, 0.0, "Joining chunks", true);
    let chunk_files: Vec<String> = (0..chunks.len()).map(|i| chunk_path(i).to_string_lossy().to_string()).collect();
    let list_path = dir.join("chunks.ffconcat");
    std::fs::write(&list_path, graph::concat_files(&chunk_files)).map_err(|e| e.to_string())?;
    let mut args: Vec<String> = ["-loglevel", "error", "-f", "concat", "-safe", "0", "-i"].map(String::from).to_vec();
    args.push(list_path.to_string_lossy().to_string());
    if has_audio_out {
        args.extend(["-i".into(), audio_path.to_string_lossy().to_string()]);
    }
    args.extend(["-map", "0:v:0"].map(String::from));
    if has_audio_out {
        args.extend(["-map", "1:a:0"].map(String::from));
    }
    args.extend(["-c", "copy"].map(String::from));
    if s.video_codec == VideoCodec::Hevc && matches!(s.container, Container::Mp4 | Container::Mov) {
        args.extend(["-tag:v", "hvc1"].map(String::from));
    }
    if matches!(s.container, Container::Mp4 | Container::Mov) {
        args.extend(["-movflags", "+faststart"].map(String::from));
    }
    args.extend(["-t".into(), ffmpeg::secs(dur)]);
    args.extend(["-progress", "pipe:1", "-nostats", "-y"].map(String::from));
    args.push(s.output_path.clone());
    run_tracked(&args, job, |_| {})?;
    Ok(format!("{encoder} ×{n_workers} parallel"))
}

fn register(state: &State<'_, ExportState>, job_id: &str) -> JobHandle {
    let h = JobHandle::default();
    state.jobs.lock().unwrap().insert(job_id.to_string(), h.clone());
    h
}

fn finish(app: &AppHandle, job_id: &str, output: &str, started: Instant, encoder: String, result: Result<(), String>) {
    let cancelled = matches!(&result, Err(e) if e == "cancelled");
    if result.is_err() {
        let _ = std::fs::remove_file(output);
    }
    let size = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    let _ = app.emit(
        "export://done",
        DoneEvent {
            job_id: job_id.to_string(),
            ok: result.is_ok(),
            cancelled,
            error: result.err().filter(|_| !cancelled),
            output: output.to_string(),
            elapsed_secs: started.elapsed().as_secs_f64(),
            size_bytes: size,
            encoder,
        },
    );
    app.state::<ExportState>().jobs.lock().unwrap().remove(job_id);
    // BEAVER_KEEP_EXPORT_TMP=1 keeps filter graphs and chunks for debugging.
    if std::env::var_os("BEAVER_KEEP_EXPORT_TMP").is_none() {
        if let Ok(d) = job_dir(app, job_id) {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

#[tauri::command]
pub fn start_export(
    app: AppHandle,
    state: State<'_, ExportState>,
    job_id: String,
    project: Project,
    settings: ExportSettings,
) -> Result<(), String> {
    if project.clips.is_empty() {
        return Err("Timeline is empty".into());
    }
    let job = register(&state, &job_id);
    std::thread::spawn(move || {
        let started = Instant::now();
        let rep = Reporter { app: app.clone(), job_id: job_id.clone(), started, last_emit: Mutex::new(Instant::now()) };
        rep.emit(0.0, 0.0, 0.0, "Starting", true);
        let encoder = resolve_encoder(&app, &settings);
        let result = job_dir(&app, &job_id).and_then(|dir| match settings.mode {
            ExportMode::Copy => copy_export(&job, &rep, &project, &settings, &dir).map(|_| "stream copy".to_string()),
            ExportMode::Turbo
                if scales_poorly(&encoder)
                    && !settings.container.is_audio_only()
                    && settings.container != Container::Gif =>
            {
                turbo_export(&job, &rep, &project, &settings, &encoder, &dir)
            }
            ExportMode::Turbo => {
                render_single(&job, &rep, &project, &settings, &encoder, &dir).map(|_| encoder.clone())
            }
            ExportMode::Render => {
                render_single(&job, &rep, &project, &settings, &encoder, &dir).map(|_| encoder.clone())
            }
        });
        let (used, res) = match result {
            Ok(e) => (e, Ok(())),
            Err(e) => (encoder, Err(e)),
        };
        finish(&app, &job_id, &settings.output_path, started, used, res);
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_export(state: State<'_, ExportState>, job_id: String) {
    if let Some(j) = state.jobs.lock().unwrap().get(&job_id) {
        j.cancel();
    }
}

#[tauri::command]
pub fn check_copy_eligible(project: Project, settings: ExportSettings) -> Result<(), String> {
    graph::copy_eligibility(&project, &settings)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinCheck {
    compatible: bool,
    reason: Option<String>,
    total_duration: f64,
    infos: Vec<MediaInfo>,
}

fn check_join(paths: &[String]) -> Result<JoinCheck, String> {
    let infos: Vec<MediaInfo> = paths.iter().map(|p| probe::probe(p)).collect::<Result<_, _>>()?;
    let total = infos.iter().map(|i| i.duration).sum();
    let mut reason = None;
    if infos.len() < 2 {
        reason = Some("Pick at least two files".to_string());
    } else if let Some(bad) = infos.iter().skip(1).find(|i| !graph::same_stream_format(&infos[0], i)) {
        let a = &infos[0];
        reason = Some(format!(
            "\"{}\" ({} {}x{} {:.2}fps, {}) differs from \"{}\" ({} {}x{} {:.2}fps, {})",
            bad.name,
            bad.vcodec,
            bad.width,
            bad.height,
            bad.fps,
            bad.acodec,
            a.name,
            a.vcodec,
            a.width,
            a.height,
            a.fps,
            a.acodec
        ));
    }
    Ok(JoinCheck { compatible: reason.is_none(), reason, total_duration: total, infos })
}

#[tauri::command]
pub async fn quick_join_check(paths: Vec<String>) -> Result<JoinCheck, String> {
    tauri::async_runtime::spawn_blocking(move || check_join(&paths)).await.map_err(|e| e.to_string())?
}

/// Lossless join of same-format files via the concat demuxer.
#[tauri::command]
pub fn quick_join(
    app: AppHandle,
    state: State<'_, ExportState>,
    job_id: String,
    paths: Vec<String>,
    output: String,
) -> Result<(), String> {
    let job = register(&state, &job_id);
    std::thread::spawn(move || {
        let started = Instant::now();
        let rep = Reporter { app: app.clone(), job_id: job_id.clone(), started, last_emit: Mutex::new(Instant::now()) };
        rep.emit(0.0, 0.0, 0.0, "Checking files", true);
        let result = (|| {
            let check = check_join(&paths)?;
            if let Some(r) = check.reason {
                return Err(r);
            }
            let dir = job_dir(&app, &job_id)?;
            let list_path = dir.join("join.ffconcat");
            std::fs::write(&list_path, graph::concat_files(&paths)).map_err(|e| e.to_string())?;
            let ext = Path::new(&output).extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_lowercase();
            let fake = ExportSettings {
                output_path: output.clone(),
                container: if ext == "mov" {
                    Container::Mov
                } else if ext == "mkv" {
                    Container::Mkv
                } else {
                    Container::Mp4
                },
                video_codec: VideoCodec::H264,
                encoder: "copy".into(),
                width: 0,
                height: 0,
                fps: 0.0,
                quality_mode: QualityMode::Crf,
                quality: Quality::High,
                bitrate_kbps: 0,
                target_size_mb: 0.0,
                speed_preset: SpeedPreset::Balanced,
                audio_codec: AudioCodec::Aac,
                audio_bitrate_kbps: 0,
                range_start: 0.0,
                range_end: 0.0,
                mode: ExportMode::Copy,
            };
            let args = graph::copy_args(&list_path.to_string_lossy(), &fake, &output);
            let total = check.total_duration.max(0.001);
            run_tracked(&args, &job, |p| rep.emit(p.out_time / total, p.fps, p.speed, "Joining", p.done))
        })();
        finish(&app, &job_id, &output, started, "stream copy".into(), result);
    });
    Ok(())
}
