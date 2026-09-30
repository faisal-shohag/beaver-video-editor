//! End-to-end renders through real FFmpeg using generated test media.
//! Verifies output durations and that joined chunks decode without errors.
use beaver_lib::ffmpeg::graph::{self, RenderSpec};
use beaver_lib::ffmpeg::{self, probe};
use beaver_lib::model::*;
use std::path::PathBuf;
use std::sync::OnceLock;

fn workdir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let d = std::env::temp_dir().join("beaver-render-tests");
        std::fs::create_dir_all(&d).unwrap();
        make_clip(&d.join("a.mp4"), "testsrc2=size=1280x720:rate=30", "sine=frequency=440", 10.0);
        make_clip(&d.join("b.mp4"), "smptebars=size=1280x720:rate=30", "sine=frequency=880", 6.0);
        make_clip(&d.join("small.mp4"), "rgbtestsrc=size=640x360:rate=30", "sine=frequency=220", 4.0);
        let args: Vec<String> =
            ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=12", "-c:a", "libmp3lame", "-y"]
                .map(String::from)
                .to_vec();
        let mut args = args;
        args.push(d.join("music.mp3").to_string_lossy().into());
        ffmpeg::run_ffmpeg(&args).unwrap();
        d
    })
}

fn make_clip(path: &std::path::Path, video: &str, audio: &str, dur: f64) {
    if path.exists() {
        return;
    }
    let args: Vec<String> = vec![
        "-loglevel".into(),
        "error".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("{video}:duration={dur}"),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("{audio}:duration={dur}"),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-g".into(),
        "30".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-shortest".into(),
        "-y".into(),
        path.to_string_lossy().into(),
    ];
    ffmpeg::run_ffmpeg(&args).unwrap();
}

fn media(id: &str, file: &str) -> MediaItem {
    let path = workdir().join(file).to_string_lossy().to_string();
    MediaItem { id: id.into(), info: probe::probe(&path).unwrap(), proxy_path: None }
}

fn track(id: &str, kind: TrackKind) -> Track {
    Track { id: id.into(), kind, name: id.into(), muted: false, hidden: false, locked: false, volume: 1.0 }
}

fn clip(id: &str, media: &str, track: &str, start: f64, i: f64, o: f64) -> Clip {
    Clip {
        id: id.into(),
        media_id: media.into(),
        track_id: track.into(),
        start,
        in_point: i,
        out_point: o,
        speed: 1.0,
        preserve_pitch: true,
        volume: 1.0,
        opacity: 1.0,
        x: 0.0,
        y: 0.0,
        scale: 1.0,
        audio_detached: false,
    }
}

fn project(clips: Vec<Clip>) -> Project {
    Project {
        name: "it".into(),
        width: 1280,
        height: 720,
        fps: 30.0,
        sample_rate: 48000,
        media: vec![media("a", "a.mp4"), media("b", "b.mp4"), media("s", "small.mp4"), media("m", "music.mp3")],
        tracks: vec![track("v1", TrackKind::Video), track("v2", TrackKind::Video), track("a1", TrackKind::Audio)],
        clips,
    }
}

fn settings(out: &str) -> ExportSettings {
    ExportSettings {
        output_path: out.into(),
        container: Container::Mp4,
        video_codec: VideoCodec::H264,
        encoder: "libx264".into(),
        width: 0,
        height: 0,
        fps: 0.0,
        quality_mode: QualityMode::Crf,
        quality: Quality::Small,
        bitrate_kbps: 0,
        target_size_mb: 0.0,
        speed_preset: SpeedPreset::Fastest,
        audio_codec: AudioCodec::Aac,
        audio_bitrate_kbps: 128,
        range_start: 0.0,
        range_end: 0.0,
        mode: ExportMode::Render,
    }
}

fn render(p: &Project, s: &ExportSettings, encoder: &str) -> MediaInfo {
    let plan = graph::build_render(&RenderSpec {
        project: p,
        settings: s,
        encoder,
        range: graph::effective_range(p, s),
        include_video: true,
        include_audio: true,
        output: &s.output_path,
        format_override: None,
        threads: None,
    })
    .unwrap();
    let script = PathBuf::from(format!("{}.graph.txt", s.output_path));
    std::fs::write(&script, &plan.filter).unwrap();
    let mut args = plan.args(&script.to_string_lossy());
    // Drop the progress pipe for tests.
    if let Some(i) = args.iter().position(|a| a == "-progress") {
        args.drain(i..i + 2);
    }
    ffmpeg::run_ffmpeg(&args).unwrap_or_else(|e| panic!("render failed: {e}\nfilter:\n{}", plan.filter));
    probe::probe(&s.output_path).unwrap()
}

fn out(name: &str) -> String {
    workdir().join(name).to_string_lossy().to_string()
}

fn assert_dur(info: &MediaInfo, expected: f64) {
    assert!((info.duration - expected).abs() < 0.1, "duration {} != {expected}", info.duration);
}

fn decodes_cleanly(path: &str) {
    let o = ffmpeg::ffmpeg().args(["-v", "error", "-i", path, "-f", "null", "-"]).output().unwrap();
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(o.status.success() && err.trim().is_empty(), "decode errors in {path}: {err}");
}

#[test]
fn cut_and_join_two_sources() {
    let p = project(vec![clip("c1", "a", "v1", 0.0, 1.0, 4.0), clip("c2", "b", "v1", 3.0, 0.0, 5.0)]);
    let s = settings(&out("cut_join.mp4"));
    let info = render(&p, &s, "libx264");
    assert_dur(&info, 8.0);
    assert!(info.has_audio && info.has_video);
    assert_eq!((info.width, info.height), (1280, 720));
}

#[test]
fn speed_up_and_slow_down() {
    let mut fast = clip("c1", "a", "v1", 0.0, 0.0, 10.0);
    fast.speed = 2.0;
    let mut slow = clip("c2", "b", "v1", 5.0, 0.0, 2.0);
    slow.speed = 0.25;
    let p = project(vec![fast, slow]);
    let info = render(&p, &settings(&out("speed.mp4")), "libx264");
    assert_dur(&info, 13.0);
}

#[test]
fn multitrack_pip_music_and_gap() {
    let mut pip = clip("c2", "s", "v2", 1.0, 0.0, 3.0);
    pip.scale = 0.35;
    pip.x = 0.3;
    pip.y = 0.3;
    pip.opacity = 0.8;
    let mut music = clip("c3", "m", "a1", 0.0, 0.0, 9.0);
    music.volume = 0.5;
    let p = project(vec![clip("c1", "a", "v1", 2.0, 0.0, 6.0), pip, music]);
    let mut s = settings(&out("multitrack.mp4"));
    s.height = 360;
    let info = render(&p, &s, "libx264");
    assert_dur(&info, 9.0);
    assert_eq!((info.width, info.height), (640, 360));
}

#[test]
fn hardware_encoder_render_if_available() {
    // Only meaningful on machines with an AMD GPU; skipped silently elsewhere.
    let p = project(vec![clip("c1", "a", "v1", 0.0, 0.0, 5.0)]);
    let s = settings(&out("amf.mp4"));
    let plan = graph::build_render(&RenderSpec {
        project: &p,
        settings: &s,
        encoder: "h264_amf",
        range: (0.0, 5.0),
        include_video: true,
        include_audio: true,
        output: &s.output_path,
        format_override: None,
        threads: None,
    })
    .unwrap();
    let mut args = plan.args_inline();
    if let Some(i) = args.iter().position(|a| a == "-progress") {
        args.drain(i..i + 2);
    }
    if ffmpeg::run_ffmpeg(&args).is_ok() {
        assert_dur(&probe::probe(&s.output_path).unwrap(), 5.0);
    } else {
        eprintln!("h264_amf unavailable, skipping");
    }
}

/// Mirrors `copy_export`: keyframe-snapped segments cut to files, then joined whole.
fn copy_render(p: &Project, s: &ExportSettings, range: (f64, f64)) {
    graph::copy_eligibility(p, s).unwrap();
    let keys: std::collections::HashMap<String, Vec<f64>> =
        p.media.iter().map(|m| (m.id.clone(), probe::keyframes(&m.info.path).unwrap())).collect();
    let snap = |m: &MediaItem, t: f64| probe::keyframe_at_or_before(&keys[&m.id], t);
    let mut files = vec![];
    for (i, seg) in graph::copy_segments(p, range, &snap).iter().enumerate() {
        let f = format!("{}.seg{i}.mkv", s.output_path);
        ffmpeg::run_ffmpeg(&graph::segment_args(seg, &f)).unwrap();
        files.push(f);
    }
    let list = format!("{}.ffconcat", s.output_path);
    std::fs::write(&list, graph::concat_files(&files)).unwrap();
    let mut args = graph::copy_args(&list, s, &s.output_path);
    if let Some(i) = args.iter().position(|a| a == "-progress") {
        args.drain(i..i + 2);
    }
    ffmpeg::run_ffmpeg(&args).unwrap();
}

#[test]
fn stream_copy_join() {
    let p = project(vec![clip("c1", "a", "v1", 0.0, 0.0, 10.0), clip("c2", "b", "v1", 10.0, 0.0, 6.0)]);
    let s = ExportSettings { mode: ExportMode::Copy, ..settings(&out("copy.mp4")) };
    copy_render(&p, &s, (0.0, 16.0));
    assert_dur(&probe::probe(&s.output_path).unwrap(), 16.0);
    decodes_cleanly(&s.output_path);
}

#[test]
fn stream_copy_cut_with_bframes_has_clean_timestamps() {
    // B-frame source (default x264) cut mid-GOP: the case that broke concat `outpoint`.
    let src = workdir().join("bframes.mp4");
    if !src.exists() {
        let args: Vec<String> = [
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:duration=12",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=12",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-g",
            "60",
            "-c:a",
            "aac",
            "-shortest",
            "-y",
        ]
        .map(String::from)
        .into_iter()
        .chain([src.to_string_lossy().to_string()])
        .collect();
        ffmpeg::run_ffmpeg(&args).unwrap();
    }
    let mut p = project(vec![clip("c1", "bf", "v1", 0.0, 0.0, 5.0), clip("c2", "bf", "v1", 5.0, 7.0, 11.0)]);
    p.media.push(MediaItem { id: "bf".into(), info: probe::probe(&src.to_string_lossy()).unwrap(), proxy_path: None });
    let s = ExportSettings { mode: ExportMode::Copy, ..settings(&out("copy_bframes.mp4")) };
    copy_render(&p, &s, (0.0, 9.0));
    decodes_cleanly(&s.output_path);
    // In-point 7 s snaps back to the 6 s keyframe, so the second segment is 5 s long.
    // Stream copy cuts on packet boundaries (AAC frames, GOP edges): allow a few frames.
    let d = probe::probe(&s.output_path).unwrap().duration;
    assert!((d - 10.0).abs() < 0.4, "duration {d}");
}

/// Mirrors turbo export: frame-aligned chunks (alternating CPU / GPU encoder when available),
/// separate audio pass, then a stream-copy join. Output must decode without errors.
#[test]
fn turbo_chunks_join_cleanly() {
    let gpu_ok = ffmpeg::run_ffmpeg(
        &[
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:duration=0.2",
            "-c:v",
            "h264_amf",
            "-f",
            "null",
            "-",
        ]
        .map(String::from),
    )
    .is_ok();
    let mut sped = clip("c2", "b", "v1", 6.0, 0.0, 6.0);
    sped.speed = 1.5;
    let p = project(vec![clip("c1", "a", "v1", 0.0, 2.0, 8.0), sped]);
    let s = settings(&out("turbo.mp4"));
    let range = graph::effective_range(&p, &s);
    let chunks = graph::chunk_ranges(range, 4, 30.0);
    let (fmt, ext) = if gpu_ok { ("mpegts", "ts") } else { ("matroska", "mkv") };
    let mut list = String::from("ffconcat version 1.0\n");
    for (i, r) in chunks.iter().enumerate() {
        let enc = if gpu_ok && i % 2 == 1 { "h264_amf" } else { "libx264" };
        let path = out(&format!("turbo_chunk_{i}.{ext}"));
        let plan = graph::build_render(&RenderSpec {
            project: &p,
            settings: &s,
            encoder: enc,
            range: *r,
            include_video: true,
            include_audio: false,
            output: &path,
            format_override: Some(fmt),
            threads: Some(4),
        })
        .unwrap();
        let mut args = plan.args_inline();
        if let Some(i) = args.iter().position(|a| a == "-progress") {
            args.drain(i..i + 2);
        }
        ffmpeg::run_ffmpeg(&args).unwrap();
        list.push_str(&format!("file '{}'\n", graph::concat_escape(&path)));
    }
    let audio = out("turbo_audio.mka");
    let plan = graph::build_render(&RenderSpec {
        project: &p,
        settings: &s,
        encoder: "libx264",
        range,
        include_video: false,
        include_audio: true,
        output: &audio,
        format_override: Some("matroska"),
        threads: None,
    })
    .unwrap();
    let mut args = plan.args_inline();
    if let Some(i) = args.iter().position(|a| a == "-progress") {
        args.drain(i..i + 2);
    }
    ffmpeg::run_ffmpeg(&args).unwrap();
    let list_path = out("turbo.ffconcat");
    std::fs::write(&list_path, list).unwrap();
    let args: Vec<String> = [
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        &list_path,
        "-i",
        &audio,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-y",
        &s.output_path,
    ]
    .map(String::from)
    .to_vec();
    ffmpeg::run_ffmpeg(&args).unwrap();
    let info = probe::probe(&s.output_path).unwrap();
    assert_dur(&info, 10.0);
    decodes_cleanly(&s.output_path);
}
