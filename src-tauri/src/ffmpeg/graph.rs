//! Turns a timeline (`Project`) plus `ExportSettings` into FFmpeg arguments.
//!
//! Everything here is pure so it can be golden-tested without running FFmpeg.
//!
//! Video strategy: each video track becomes one stream built by `concat`-ing clip
//! segments and gap fillers, so a single-track edit needs no `overlay` at all. The
//! lowest track with content is the opaque base; higher tracks are rendered with
//! alpha and overlaid on top. Audio: every audible clip is trimmed, retimed, delayed
//! to its timeline position and summed with `amix`.
use super::{num, secs};
use crate::model::*;
use std::fmt::Write as _;

#[derive(Debug, Clone)]
pub struct RenderSpec<'a> {
    pub project: &'a Project,
    pub settings: &'a ExportSettings,
    /// Concrete FFmpeg encoder name (already resolved from "auto").
    pub encoder: &'a str,
    pub range: (f64, f64),
    pub include_video: bool,
    pub include_audio: bool,
    pub output: &'a str,
    /// Force the output muxer (turbo chunks).
    pub format_override: Option<&'a str>,
    /// Limit encoder threads (turbo workers share the CPU).
    pub threads: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct RenderPlan {
    pub inputs: Vec<String>,
    pub filter: String,
    pub outputs: Vec<String>,
    pub duration: f64,
}

impl RenderPlan {
    /// Final argument list, reading the filter graph from `filter_script`
    /// (avoids the 32K Windows command-line limit on big timelines).
    pub fn args(&self, filter_script: &str) -> Vec<String> {
        let mut a = self.inputs.clone();
        a.push("-/filter_complex".into());
        a.push(filter_script.into());
        a.extend(self.outputs.iter().cloned());
        a
    }

    pub fn args_inline(&self) -> Vec<String> {
        let mut a = self.inputs.clone();
        a.push("-filter_complex".into());
        a.push(self.filter.clone());
        a.extend(self.outputs.iter().cloned());
        a
    }
}

fn even(x: f64) -> u32 {
    let v = (x / 2.0).round() as u32 * 2;
    v.max(2)
}

/// Output frame size honouring the project aspect ratio when only a height is requested.
pub fn output_size(project: &Project, s: &ExportSettings) -> (u32, u32) {
    let aspect = project.width as f64 / project.height.max(1) as f64;
    if s.container == Container::Gif && s.width == 0 && s.height == 0 {
        let w = 480.0_f64.min(project.width as f64);
        return (even(w), even(w / aspect));
    }
    match (s.width, s.height) {
        (0, 0) => (even(project.width as f64), even(project.height as f64)),
        (0, h) => (even(h as f64 * aspect), even(h as f64)),
        (w, 0) => (even(w as f64), even(w as f64 / aspect)),
        (w, h) => (even(w as f64), even(h as f64)),
    }
}

pub fn output_fps(project: &Project, s: &ExportSettings) -> f64 {
    let f = if s.fps > 0.0 { s.fps } else { project.fps };
    if s.container == Container::Gif {
        f.min(15.0)
    } else {
        f
    }
}

/// Resolve the effective export range, clamped to the timeline.
pub fn effective_range(project: &Project, s: &ExportSettings) -> (f64, f64) {
    let total = project.duration();
    let start = s.range_start.clamp(0.0, total);
    let end = if s.range_end > start { s.range_end.min(total) } else { total };
    (start, end)
}

/// A clip portion that falls inside the export range.
#[derive(Debug, Clone)]
struct Piece<'a> {
    clip: &'a Clip,
    media: &'a MediaItem,
    /// Output-relative start/end (seconds from range start).
    out_start: f64,
    out_end: f64,
    src_in: f64,
    src_dur: f64,
}

fn piece<'a>(clip: &'a Clip, media: &'a MediaItem, range: (f64, f64), min_len: f64) -> Option<Piece<'a>> {
    let t0 = clip.start.max(range.0);
    let t1 = clip.end().min(range.1);
    if t1 - t0 < min_len {
        return None;
    }
    Some(Piece {
        clip,
        media,
        out_start: t0 - range.0,
        out_end: t1 - range.0,
        src_in: clip.in_point + (t0 - clip.start) * clip.speed,
        src_dur: (t1 - t0) * clip.speed,
    })
}

/// `atempo` accepts 0.5..=100, so slower factors are chained.
pub fn atempo_chain(speed: f64) -> Vec<String> {
    let mut out = vec![];
    let mut s = speed;
    while s < 0.5 {
        out.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    while s > 100.0 {
        out.push("atempo=100".to_string());
        s /= 100.0;
    }
    if (s - 1.0).abs() > 1e-9 {
        out.push(format!("atempo={}", num(s)));
    }
    out
}

struct Inputs {
    args: Vec<String>,
    count: usize,
}

impl Inputs {
    /// Export always reads the original media (or its enhanced audio), never the preview proxy.
    fn add(&mut self, path: &str, p: &Piece) -> usize {
        self.args.extend([
            "-ss".into(),
            secs(p.src_in),
            "-t".into(),
            secs(p.src_dur + 0.05),
            "-i".into(),
            path.to_string(),
        ]);
        self.count += 1;
        self.count - 1
    }
}

pub fn build_render(spec: &RenderSpec) -> Result<RenderPlan, String> {
    let p = spec.project;
    let s = spec.settings;
    let (rs, re) = spec.range;
    let dur = re - rs;
    if dur <= 0.0 {
        return Err("Nothing to export: timeline range is empty".into());
    }
    let (w, h) = output_size(p, s);
    let fps = output_fps(p, s);
    let frame = 1.0 / fps;
    let sr = if p.sample_rate > 0 { p.sample_rate } else { 48_000 };
    let audio_only_container = s.container.is_audio_only();
    let want_video = spec.include_video && !audio_only_container;
    let want_audio = spec.include_audio && s.audio_codec != AudioCodec::None && s.container != Container::Gif;
    if !want_video && !want_audio {
        return Err("Export has neither video nor audio".into());
    }

    let mut inputs = Inputs { args: vec![], count: 0 };
    let mut f = String::new();
    // Input index per clip id so video and audio of one clip share a decoder.
    let mut input_of: Vec<(String, usize)> = vec![];
    let mut input_for = |piece: &Piece, inputs: &mut Inputs| -> usize {
        if let Some((_, i)) = input_of.iter().find(|(id, _)| *id == piece.clip.id) {
            return *i;
        }
        let i = inputs.add(&piece.media.info.path, piece);
        input_of.push((piece.clip.id.clone(), i));
        i
    };

    // ---------- video ----------
    if want_video {
        let mut track_streams: Vec<String> = vec![];
        let mut base_done = false;
        let video_tracks = p.tracks.iter().filter(|t| t.kind == TrackKind::Video && !t.hidden);
        for (ti, track) in video_tracks.enumerate() {
            let mut pieces: Vec<Piece> = p
                .clips
                .iter()
                .filter(|c| c.track_id == track.id)
                .filter_map(|c| p.media(&c.media_id).filter(|m| m.info.has_video).map(|m| (c, m)))
                .filter_map(|(c, m)| piece(c, m, (rs, re), frame * 0.5))
                .collect();
            if pieces.is_empty() {
                continue;
            }
            pieces.sort_by(|a, b| a.out_start.total_cmp(&b.out_start));
            let is_base = !base_done;
            base_done = true;
            let (fmt, gap_color) = if is_base { ("yuv420p", "black") } else { ("yuva420p", "black@0.0") };

            let mut segs: Vec<String> = vec![];
            let mut cursor = 0.0_f64;
            for (pi, pc) in pieces.iter().enumerate() {
                let mut pc = pc.clone();
                if pc.out_start < cursor {
                    // Overlap inside a track: drop the hidden head of this clip.
                    let cut = cursor - pc.out_start;
                    pc.out_start = cursor;
                    pc.src_in += cut * pc.clip.speed;
                    pc.src_dur -= cut * pc.clip.speed;
                    if pc.out_end - pc.out_start < frame * 0.5 {
                        continue;
                    }
                }
                let gap = pc.out_start - cursor;
                if gap >= frame * 0.5 {
                    let label = format!("t{ti}g{pi}");
                    writeln!(
                        f,
                        "color=c={gap_color}:s={w}x{h}:r={fr}:d={d},format={fmt}[{label}];",
                        fr = num(fps),
                        d = secs(gap)
                    )
                    .unwrap();
                    segs.push(label);
                }
                let idx = input_for(&pc, &mut inputs);
                let seg_dur = pc.out_end - pc.out_start;
                let label = format!("t{ti}c{pi}");
                let c = pc.clip;
                let mut chain = vec![];
                if (c.speed - 1.0).abs() > 1e-9 {
                    chain.push(format!("setpts=(PTS-STARTPTS)/{}", num(c.speed)));
                } else {
                    chain.push("setpts=PTS-STARTPTS".into());
                }
                chain.push(format!("fps={}", num(fps)));
                chain.push(format!("tpad=stop_mode=clone:stop_duration={}", secs(seg_dur)));
                chain.push(format!("trim=duration={}", secs(seg_dur)));
                let sw = even(w as f64 * c.scale.max(0.01));
                let sh = even(h as f64 * c.scale.max(0.01));
                chain.push(format!("scale=w={sw}:h={sh}:force_original_aspect_ratio=decrease:force_divisible_by=2"));
                chain.push("setsar=1".into());
                let translucent = c.opacity < 0.999;
                let needs_overlay = c.has_transform() || (translucent && is_base);
                if translucent {
                    chain.push("format=yuva420p".into());
                    chain.push(format!("colorchannelmixer=aa={}", num(c.opacity.max(0.0))));
                }
                if needs_overlay {
                    let src = format!("{label}s");
                    let bg = format!("{label}b");
                    writeln!(f, "[{idx}:v]{}[{src}];", chain.join(",")).unwrap();
                    writeln!(
                        f,
                        "color=c={gap_color}:s={w}x{h}:r={fr}:d={d},format={bgfmt}[{bg}];",
                        fr = num(fps),
                        d = secs(seg_dur),
                        bgfmt = if is_base { "yuv420p" } else { "yuva420p" }
                    )
                    .unwrap();
                    let x = format!("(W-w)/2+({})*W", num(c.x));
                    let y = format!("(H-h)/2+({})*H", num(c.y));
                    writeln!(
                        f,
                        "[{bg}][{src}]overlay=x='{x}':y='{y}':eval=init:format=auto:eof_action=pass,format={fmt}[{label}];"
                    )
                    .unwrap();
                } else {
                    if !is_base && !translucent {
                        chain.push("format=yuva420p".into());
                    }
                    chain.push(format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={gap_color}"));
                    chain.push(format!("format={fmt}"));
                    writeln!(f, "[{idx}:v]{}[{label}];", chain.join(",")).unwrap();
                }
                segs.push(label);
                cursor = pc.out_end;
            }
            if is_base && dur - cursor >= frame * 0.5 {
                let label = format!("t{ti}tail");
                writeln!(
                    f,
                    "color=c=black:s={w}x{h}:r={fr}:d={d},format=yuv420p[{label}];",
                    fr = num(fps),
                    d = secs(dur - cursor)
                )
                .unwrap();
                segs.push(label);
            }
            let out = format!("track{ti}");
            if segs.len() == 1 {
                writeln!(f, "[{}]null[{out}];", segs[0]).unwrap();
            } else {
                let joined: String = segs.iter().map(|l| format!("[{l}]")).collect();
                writeln!(f, "{joined}concat=n={}:v=1:a=0[{out}];", segs.len()).unwrap();
            }
            track_streams.push(out);
        }

        if track_streams.is_empty() {
            writeln!(f, "color=c=black:s={w}x{h}:r={}:d={},format=yuv420p[track_black];", num(fps), secs(dur)).unwrap();
            track_streams.push("track_black".into());
        }
        let mut cur = track_streams[0].clone();
        for (i, upper) in track_streams.iter().enumerate().skip(1) {
            let next = format!("comp{i}");
            writeln!(f, "[{cur}][{upper}]overlay=eof_action=pass:format=auto[{next}];").unwrap();
            cur = next;
        }
        let final_fmt = pixel_format(s.video_codec, spec.encoder);
        if s.container == Container::Gif {
            writeln!(
                f,
                "[{cur}]split[gif_a][gif_b];[gif_a]palettegen=stats_mode=diff[gif_p];[gif_b][gif_p]paletteuse=dither=bayer:bayer_scale=4[vout];"
            )
            .unwrap();
        } else {
            writeln!(f, "[{cur}]format={final_fmt}[vout];").unwrap();
        }
    }

    // ---------- audio ----------
    if want_audio {
        let mut labels = vec![];
        for track in &p.tracks {
            if track.muted {
                continue;
            }
            for c in p.clips.iter().filter(|c| c.track_id == track.id) {
                if track.kind == TrackKind::Video && c.audio_detached {
                    continue;
                }
                let Some(m) = p.media(&c.media_id).filter(|m| m.info.has_audio) else { continue };
                let vol = c.volume * track.volume;
                if vol <= 1e-4 {
                    continue;
                }
                let Some(pc) = piece(c, m, (rs, re), 0.01) else { continue };
                // Enhanced audio lives in its own file on the media's timeline, so the same trim applies.
                let idx = match c.enhanced_audio() {
                    Some(path) => inputs.add(path, &pc),
                    None => input_for(&pc, &mut inputs),
                };
                let seg_dur = pc.out_end - pc.out_start;
                let label = format!("a{}", labels.len());
                let mut chain = vec!["asetpts=PTS-STARTPTS".to_string(), format!("aresample={sr}")];
                if (c.speed - 1.0).abs() > 1e-9 {
                    if c.preserve_pitch {
                        chain.extend(atempo_chain(c.speed));
                    } else {
                        chain.push(format!("asetrate={}", num(sr as f64 * c.speed)));
                        chain.push(format!("aresample={sr}"));
                    }
                }
                chain.push(format!("aformat=sample_rates={sr}:channel_layouts=stereo"));
                if (vol - 1.0).abs() > 1e-6 {
                    chain.push(format!("volume={}", num(vol)));
                }
                chain.push(format!("apad=whole_dur={}", secs(seg_dur)));
                chain.push(format!("atrim=duration={}", secs(seg_dur)));
                let delay_ms = (pc.out_start * 1000.0).round() as i64;
                if delay_ms > 0 {
                    chain.push(format!("adelay=delays={delay_ms}:all=1"));
                }
                writeln!(f, "[{idx}:a]{}[{label}];", chain.join(",")).unwrap();
                labels.push(label);
            }
        }
        if labels.is_empty() {
            writeln!(f, "anullsrc=r={sr}:cl=stereo,atrim=duration={}[aout];", secs(dur)).unwrap();
        } else {
            let mixed = if labels.len() == 1 {
                format!("[{}]", labels[0])
            } else {
                let joined: String = labels.iter().map(|l| format!("[{l}]")).collect();
                writeln!(
                    f,
                    "{joined}amix=inputs={}:normalize=0:dropout_transition=0:duration=longest[amixed];",
                    labels.len()
                )
                .unwrap();
                "[amixed]".to_string()
            };
            writeln!(f, "{mixed}apad=whole_dur={d},atrim=duration={d}[aout];", d = secs(dur)).unwrap();
        }
    }

    let filter = f.trim_end().trim_end_matches(';').to_string();

    // ---------- outputs ----------
    let mut out: Vec<String> = vec![];
    if want_video {
        out.extend(["-map".into(), "[vout]".into()]);
    }
    if want_audio {
        out.extend(["-map".into(), "[aout]".into()]);
    }
    if want_video {
        if s.container == Container::Gif {
            out.extend(["-c:v".into(), "gif".into(), "-loop".into(), "0".into()]);
        } else {
            out.extend(video_encoder_args(spec.encoder, s, dur, spec.threads));
            if matches!(s.video_codec, VideoCodec::Hevc) && matches!(s.container, Container::Mp4 | Container::Mov) {
                out.extend(["-tag:v".into(), "hvc1".into()]);
            }
        }
        out.extend(["-r".into(), num(fps)]);
    }
    if want_audio {
        out.extend(audio_encoder_args(s));
    }
    if matches!(s.container, Container::Mp4 | Container::Mov | Container::M4a) && spec.format_override.is_none() {
        out.extend(["-movflags".into(), "+faststart".into()]);
    }
    if let Some(fmt) = spec.format_override {
        out.extend(["-f".into(), fmt.into()]);
    }
    out.extend(["-t".into(), secs(dur)]);
    out.extend(["-progress".into(), "pipe:1".into(), "-nostats".into(), "-y".into(), spec.output.into()]);

    let mut input_args = vec!["-loglevel".to_string(), "error".to_string()];
    input_args.extend(inputs.args);
    Ok(RenderPlan { inputs: input_args, filter, outputs: out, duration: dur })
}

pub fn pixel_format(codec: VideoCodec, encoder: &str) -> &'static str {
    match codec {
        VideoCodec::Prores => "yuv422p10le",
        _ if encoder.ends_with("_qsv") || encoder.ends_with("_amf") || encoder.ends_with("_nvenc") => "nv12",
        _ => "yuv420p",
    }
}

fn q_value(q: Quality, [high, medium, small]: [u32; 3]) -> String {
    match q {
        Quality::High => high,
        Quality::Medium => medium,
        Quality::Small => small,
    }
    .to_string()
}

/// Video bitrate (kbps) to hit a target file size.
pub fn bitrate_for_size(size_mb: f64, duration: f64, audio_kbps: u32) -> u32 {
    let total_kbps = size_mb * 8.0 * 1024.0 / duration.max(0.1);
    ((total_kbps * 0.97) as i64 - audio_kbps as i64).max(100) as u32
}

pub fn video_encoder_args(encoder: &str, s: &ExportSettings, duration: f64, threads: Option<u32>) -> Vec<String> {
    let mut a: Vec<String> = vec!["-c:v".into(), encoder.into()];
    let push = |a: &mut Vec<String>, k: &str, v: String| {
        a.push(k.into());
        a.push(v);
    };
    let audio_kbps = if s.audio_codec == AudioCodec::None { 0 } else { s.audio_bitrate_kbps };
    let kbps = match s.quality_mode {
        QualityMode::Crf => None,
        QualityMode::Bitrate => Some(s.bitrate_kbps.max(100)),
        QualityMode::Size => Some(bitrate_for_size(s.target_size_mb, duration, audio_kbps)),
    };
    let sp = s.speed_preset;
    let pick = |f: &'static str, b: &'static str, q: &'static str| -> String {
        match sp {
            SpeedPreset::Fastest => f,
            SpeedPreset::Balanced => b,
            SpeedPreset::Quality => q,
        }
        .to_string()
    };
    let bitrate = |a: &mut Vec<String>, k: u32| {
        a.extend([
            "-b:v".into(),
            format!("{k}k"),
            "-maxrate".into(),
            format!("{}k", k * 3 / 2),
            "-bufsize".into(),
            format!("{}k", k * 2),
        ]);
    };

    match encoder {
        "libx264" => {
            push(&mut a, "-preset", pick("veryfast", "faster", "slow"));
            match kbps {
                None => push(&mut a, "-crf", q_value(s.quality, [18, 22, 27])),
                Some(k) => bitrate(&mut a, k),
            }
            push(&mut a, "-profile:v", "high".into());
        }
        "libx265" => {
            push(&mut a, "-preset", pick("superfast", "fast", "slow"));
            match kbps {
                None => push(&mut a, "-crf", q_value(s.quality, [20, 25, 30])),
                Some(k) => bitrate(&mut a, k),
            }
            push(&mut a, "-x265-params", "log-level=error".into());
        }
        "libsvtav1" => {
            push(&mut a, "-preset", pick("10", "8", "5"));
            match kbps {
                None => push(&mut a, "-crf", q_value(s.quality, [26, 32, 40])),
                Some(k) => push(&mut a, "-b:v", format!("{k}k")),
            }
        }
        "libvpx-vp9" => {
            push(&mut a, "-deadline", pick("realtime", "good", "good"));
            push(&mut a, "-cpu-used", pick("8", "4", "2"));
            push(&mut a, "-row-mt", "1".into());
            match kbps {
                None => {
                    push(&mut a, "-crf", q_value(s.quality, [24, 32, 40]));
                    push(&mut a, "-b:v", "0".into());
                }
                Some(k) => push(&mut a, "-b:v", format!("{k}k")),
            }
        }
        "prores_ks" => {
            push(&mut a, "-profile:v", q_value(s.quality, [3, 2, 0]));
            push(&mut a, "-vendor", "apl0".into());
        }
        e if e.ends_with("_amf") => {
            push(&mut a, "-usage", "transcoding".into());
            push(&mut a, "-quality", pick("speed", "balanced", "quality"));
            match kbps {
                None => {
                    let q = if e.starts_with("h264") {
                        q_value(s.quality, [20, 24, 29])
                    } else {
                        q_value(s.quality, [22, 26, 31])
                    };
                    push(&mut a, "-rc", "cqp".into());
                    push(&mut a, "-qp_i", q.clone());
                    push(&mut a, "-qp_p", q.clone());
                    if e.starts_with("h264") {
                        push(&mut a, "-qp_b", q);
                    }
                }
                Some(k) => {
                    push(&mut a, "-rc", "vbr_peak".into());
                    bitrate(&mut a, k);
                }
            }
        }
        e if e.ends_with("_nvenc") => {
            push(&mut a, "-preset", pick("p1", "p4", "p6"));
            match kbps {
                None => {
                    push(&mut a, "-rc", "vbr".into());
                    push(&mut a, "-cq", q_value(s.quality, [19, 24, 30]));
                    push(&mut a, "-b:v", "0".into());
                }
                Some(k) => {
                    push(&mut a, "-rc", "vbr".into());
                    bitrate(&mut a, k);
                }
            }
        }
        e if e.ends_with("_qsv") => {
            push(&mut a, "-preset", pick("veryfast", "medium", "slower"));
            match kbps {
                None => push(&mut a, "-global_quality", q_value(s.quality, [20, 25, 30])),
                Some(k) => bitrate(&mut a, k),
            }
        }
        _ => {
            if let Some(k) = kbps {
                bitrate(&mut a, k);
            }
        }
    }
    if let Some(t) = threads {
        if !encoder.contains("_amf") && !encoder.contains("_nvenc") && !encoder.contains("_qsv") {
            push(&mut a, "-threads", t.to_string());
        }
    }
    a
}

pub fn audio_encoder_args(s: &ExportSettings) -> Vec<String> {
    let br = format!("{}k", s.audio_bitrate_kbps.clamp(32, 512));
    let codec = match s.container {
        Container::Mp3 => AudioCodec::Mp3,
        Container::Wav => AudioCodec::Pcm,
        Container::M4a => AudioCodec::Aac,
        Container::Webm => AudioCodec::Opus,
        Container::Mov if s.audio_codec == AudioCodec::Opus => AudioCodec::Aac,
        _ => s.audio_codec,
    };
    match codec {
        AudioCodec::Aac => vec!["-c:a".into(), "aac".into(), "-b:a".into(), br],
        AudioCodec::Opus => vec!["-c:a".into(), "libopus".into(), "-b:a".into(), br],
        AudioCodec::Mp3 => vec!["-c:a".into(), "libmp3lame".into(), "-b:a".into(), br],
        AudioCodec::Pcm => vec!["-c:a".into(), "pcm_s16le".into()],
        AudioCodec::None => vec!["-an".into()],
    }
}

// ---------------------------------------------------------------------------
// Lossless stream-copy path
// ---------------------------------------------------------------------------

/// Checks whether the timeline can be exported with `-c copy`.
pub fn copy_eligibility(p: &Project, s: &ExportSettings) -> Result<(), String> {
    if s.container == Container::Gif || s.container.is_audio_only() {
        return Err("Fast copy supports video containers only".into());
    }
    let (rs, re) = effective_range(p, s);
    let in_range: Vec<&Clip> = p.clips.iter().filter(|c| c.end() > rs + 1e-3 && c.start < re - 1e-3).collect();
    if in_range.is_empty() {
        return Err("Nothing to export".into());
    }
    let first_track = &in_range[0].track_id;
    if in_range.iter().any(|c| &c.track_id != first_track) {
        return Err("Fast copy needs all clips on one track (multi-track edits must be rendered)".into());
    }
    let track = p.track(first_track).ok_or("Unknown track")?;
    if track.kind != TrackKind::Video || track.hidden || track.muted || (track.volume - 1.0).abs() > 1e-6 {
        return Err("Fast copy needs a visible, unmuted video track at 100% volume".into());
    }
    let mut clips = in_range.clone();
    clips.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut cursor = rs;
    let mut reference: Option<&MediaInfo> = None;
    for c in clips {
        if (c.speed - 1.0).abs() > 1e-6 {
            return Err("Speed changes need a render".into());
        }
        if (c.volume - 1.0).abs() > 1e-6 || (c.opacity - 1.0).abs() > 1e-6 || c.has_transform() || c.audio_detached {
            return Err("Volume, opacity or transform changes need a render".into());
        }
        if c.enhance.is_some() {
            return Err("Enhanced audio needs a render".into());
        }
        if c.start.max(rs) - cursor > 0.05 {
            return Err("Gaps between clips need a render".into());
        }
        cursor = c.end();
        let m = &p.media(&c.media_id).ok_or("Missing media")?.info;
        if !m.has_video {
            return Err("Audio-only clip on video track".into());
        }
        if let Some(r) = reference {
            if !same_stream_format(r, m) {
                return Err(format!("\"{}\" has a different format than \"{}\" — render instead", m.name, r.name));
            }
        } else {
            reference = Some(m);
        }
    }
    let r = reference.unwrap();
    if s.container == Container::Webm && !matches!(r.vcodec.as_str(), "vp8" | "vp9" | "av1") {
        return Err("WebM copy needs VP8/VP9/AV1 source".into());
    }
    Ok(())
}

/// True when two files can be joined losslessly with the concat demuxer.
pub fn same_stream_format(a: &MediaInfo, b: &MediaInfo) -> bool {
    a.has_video == b.has_video
        && a.has_audio == b.has_audio
        && a.vcodec == b.vcodec
        && a.width == b.width
        && a.height == b.height
        && (a.fps - b.fps).abs() < 0.02
        && a.pix_fmt == b.pix_fmt
        && a.acodec == b.acodec
        && a.sample_rate == b.sample_rate
        && a.channels == b.channels
}

pub fn concat_escape(path: &str) -> String {
    path.replace('\\', "/").replace('\'', "'\\''")
}

/// Source segment for the lossless path.
#[derive(Debug, Clone, PartialEq)]
pub struct CopySegment {
    pub path: String,
    pub start: f64,
    pub duration: f64,
}

/// Segments of the clips inside `range` (single-track timeline), in timeline order.
/// `snap_in` moves each in-point to a keyframe, the only place stream copy can start.
pub fn copy_segments(p: &Project, range: (f64, f64), snap_in: &dyn Fn(&MediaItem, f64) -> f64) -> Vec<CopySegment> {
    let mut clips: Vec<&Clip> = p.clips.iter().collect();
    clips.sort_by(|a, b| a.start.total_cmp(&b.start));
    clips
        .into_iter()
        .filter_map(|c| {
            let m = p.media(&c.media_id)?;
            let pc = piece(c, m, range, 0.01)?;
            let start = snap_in(m, pc.src_in);
            Some(CopySegment { path: m.info.path.clone(), start, duration: pc.src_in + pc.src_dur - start })
        })
        .collect()
}

/// Cut one segment to its own file. Joining whole files afterwards keeps timestamps
/// monotonic; concat-demuxer `outpoint` leaves B-frame reorder overlap at every join.
pub fn segment_args(seg: &CopySegment, output: &str) -> Vec<String> {
    [
        "-loglevel",
        "error",
        "-ss",
        &secs(seg.start),
        "-t",
        &secs(seg.duration),
        "-i",
        &seg.path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        "-f",
        "matroska",
        "-y",
        output,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// `ffconcat` list joining whole files.
pub fn concat_files(paths: &[String]) -> String {
    let mut out = String::from("ffconcat version 1.0\n");
    for p in paths {
        writeln!(out, "file '{}'", concat_escape(p)).unwrap();
    }
    out
}

pub fn copy_args(list_path: &str, s: &ExportSettings, output: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if matches!(s.container, Container::Mp4 | Container::Mov) {
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.extend(["-progress".into(), "pipe:1".into(), "-nostats".into(), "-y".into(), output.into()]);
    a
}

// ---------------------------------------------------------------------------
// Turbo: chunk boundaries
// ---------------------------------------------------------------------------

/// Split `range` into `n` frame-aligned chunks.
pub fn chunk_ranges(range: (f64, f64), n: usize, fps: f64) -> Vec<(f64, f64)> {
    let total_frames = ((range.1 - range.0) * fps).round() as i64;
    let n = (n as i64).clamp(1, total_frames.max(1));
    let mut out = vec![];
    for i in 0..n {
        let f0 = total_frames * i / n;
        let f1 = total_frames * (i + 1) / n;
        if f1 > f0 {
            out.push((range.0 + f0 as f64 / fps, range.0 + f1 as f64 / fps));
        }
    }
    if let Some(last) = out.last_mut() {
        last.1 = range.1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(id: &str, dur: f64) -> MediaItem {
        MediaItem {
            id: id.into(),
            info: MediaInfo {
                path: format!("C:/media/{id}.mp4"),
                name: format!("{id}.mp4"),
                duration: dur,
                size_bytes: 1,
                format_name: "mov,mp4".into(),
                has_video: true,
                has_audio: true,
                width: 1920,
                height: 1080,
                fps: 30.0,
                vcodec: "h264".into(),
                pix_fmt: "yuv420p".into(),
                acodec: "aac".into(),
                sample_rate: 48000,
                channels: 2,
                rotation: 0,
            },
            proxy_path: None,
        }
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
            enhance: None,
        }
    }

    fn project(clips: Vec<Clip>) -> Project {
        Project {
            name: "t".into(),
            width: 1920,
            height: 1080,
            fps: 30.0,
            sample_rate: 48000,
            media: vec![media("m1", 20.0), media("m2", 20.0)],
            tracks: vec![track("v1", TrackKind::Video), track("v2", TrackKind::Video), track("a1", TrackKind::Audio)],
            clips,
        }
    }

    fn settings() -> ExportSettings {
        ExportSettings {
            output_path: "C:/out/o.mp4".into(),
            container: Container::Mp4,
            video_codec: VideoCodec::H264,
            encoder: "auto".into(),
            width: 0,
            height: 0,
            fps: 0.0,
            quality_mode: QualityMode::Crf,
            quality: Quality::Medium,
            bitrate_kbps: 8000,
            target_size_mb: 50.0,
            speed_preset: SpeedPreset::Balanced,
            audio_codec: AudioCodec::Aac,
            audio_bitrate_kbps: 192,
            range_start: 0.0,
            range_end: 0.0,
            mode: ExportMode::Render,
        }
    }

    fn plan(p: &Project, s: &ExportSettings) -> RenderPlan {
        build_render(&RenderSpec {
            project: p,
            settings: s,
            encoder: "libx264",
            range: effective_range(p, s),
            include_video: true,
            include_audio: true,
            output: "out.mp4",
            format_override: None,
            threads: None,
        })
        .unwrap()
    }

    #[test]
    fn split_clips_concat_without_overlay() {
        // One source split into two pieces with the middle cut out.
        let p = project(vec![clip("c1", "m1", "v1", 0.0, 0.0, 4.0), clip("c2", "m1", "v1", 4.0, 6.0, 10.0)]);
        let pl = plan(&p, &settings());
        assert_eq!(pl.duration, 8.0);
        assert!(pl.filter.contains("[t0c0][t0c1]concat=n=2:v=1:a=0[track0]"), "{}", pl.filter);
        assert!(!pl.filter.contains("overlay"));
        // Second clip seeks to its in point.
        let args = pl.args_inline();
        let pos = args.iter().position(|a| a == "6").expect("seek to 6s");
        assert_eq!(args[pos - 1], "-ss");
        // Audio: second piece delayed by 4s.
        assert!(pl.filter.contains("adelay=delays=4000:all=1"));
        assert!(pl.filter.contains("amix=inputs=2"));
        assert!(args.windows(2).any(|w| w[0] == "-crf" && w[1] == "22"));
    }

    #[test]
    fn speed_changes_video_and_audio() {
        let mut c = clip("c1", "m1", "v1", 0.0, 0.0, 10.0);
        c.speed = 2.0;
        let p = project(vec![c]);
        let pl = plan(&p, &settings());
        assert_eq!(pl.duration, 5.0);
        assert!(pl.filter.contains("setpts=(PTS-STARTPTS)/2"));
        assert!(pl.filter.contains("atempo=2"));
        assert!(pl.filter.contains("trim=duration=5"));
    }

    #[test]
    fn slow_motion_chains_atempo() {
        assert_eq!(atempo_chain(0.25), vec!["atempo=0.5", "atempo=0.5"]);
        assert_eq!(atempo_chain(0.3), vec!["atempo=0.5", "atempo=0.6"]);
        assert!(atempo_chain(1.0).is_empty());
        assert_eq!(atempo_chain(16.0), vec!["atempo=16"]);
    }

    #[test]
    fn pitch_shift_mode_uses_asetrate() {
        let mut c = clip("c1", "m1", "v1", 0.0, 0.0, 10.0);
        c.speed = 0.5;
        c.preserve_pitch = false;
        let pl = plan(&project(vec![c]), &settings());
        assert!(pl.filter.contains("asetrate=24000"));
        assert!(!pl.filter.contains("atempo"));
    }

    #[test]
    fn multitrack_overlays_upper_track_with_leading_gap() {
        let mut pip = clip("c2", "m2", "v2", 2.0, 0.0, 3.0);
        pip.scale = 0.3;
        pip.x = 0.3;
        pip.y = -0.3;
        let p = project(vec![clip("c1", "m1", "v1", 0.0, 0.0, 10.0), pip]);
        let pl = plan(&p, &settings());
        // Upper track: transparent 2s gap, then the transformed clip.
        assert!(pl.filter.contains("color=c=black@0.0:s=1920x1080:r=30:d=2,format=yuva420p[t1g0]"), "{}", pl.filter);
        assert!(pl.filter.contains("scale=w=576:h=324"));
        assert!(pl.filter.contains("overlay=x='(W-w)/2+(0.3)*W':y='(H-h)/2+(-0.3)*H'"));
        assert!(pl.filter.contains("[track0][track1]overlay=eof_action=pass"));
        assert!(pl.filter.contains("[comp1]format=yuv420p[vout]"));
    }

    #[test]
    fn base_track_gap_is_black_and_tail_filled() {
        let p = project(vec![clip("c1", "m1", "v1", 1.0, 0.0, 2.0), clip("c2", "m2", "a1", 0.0, 0.0, 5.0)]);
        let pl = plan(&p, &settings());
        assert_eq!(pl.duration, 5.0);
        assert!(pl.filter.contains("color=c=black:s=1920x1080:r=30:d=1,format=yuv420p[t0g0]"));
        assert!(pl.filter.contains("d=2,format=yuv420p[t0tail]"));
    }

    #[test]
    fn muted_track_and_detached_audio_skipped() {
        let mut c = clip("c1", "m1", "v1", 0.0, 0.0, 5.0);
        c.audio_detached = true;
        let mut p = project(vec![c, clip("c2", "m1", "a1", 0.0, 0.0, 5.0)]);
        p.tracks[2].muted = true;
        let pl = plan(&p, &settings());
        assert!(pl.filter.contains("anullsrc"));
        assert!(!pl.filter.contains(":a]"));
    }

    #[test]
    fn enhanced_clip_reads_audio_from_enhanced_file() {
        let mut c = clip("c1", "m1", "v1", 0.0, 2.0, 8.0);
        c.speed = 2.0;
        c.enhance = Some(Enhance {
            model: EnhanceModel::Dfn3,
            strength: EnhanceStrength::Full,
            path: Some("C:/cache/m1_dfn3_full.wav".into()),
        });
        let p = project(vec![c]);
        let pl = plan(&p, &settings());
        let args = pl.args_inline();
        let inputs: Vec<&String> = args.windows(2).filter(|w| w[0] == "-i").map(|w| &w[1]).collect();
        assert_eq!(inputs, [&"C:/media/m1.mp4".to_string(), &"C:/cache/m1_dfn3_full.wav".to_string()]);
        // Both inputs seek to the same source point; audio keeps its speed chain.
        assert_eq!(args.iter().filter(|a| *a == "2").count(), 2, "{args:?}");
        assert!(pl.filter.contains("[0:v]"));
        assert!(pl.filter.contains("[1:a]asetpts=PTS-STARTPTS,aresample=48000,atempo=2"), "{}", pl.filter);
        assert!(copy_eligibility(&p, &settings()).is_err());
    }

    #[test]
    fn range_export_trims_sources() {
        let p = project(vec![clip("c1", "m1", "v1", 0.0, 2.0, 12.0)]);
        let mut s = settings();
        s.range_start = 3.0;
        s.range_end = 7.0;
        let pl = plan(&p, &s);
        assert_eq!(pl.duration, 4.0);
        let args = pl.args_inline();
        assert!(args.windows(2).any(|w| w[0] == "-ss" && w[1] == "5"));
    }

    #[test]
    fn output_size_keeps_aspect() {
        let p = project(vec![]);
        let mut s = settings();
        s.height = 720;
        assert_eq!(output_size(&p, &s), (1280, 720));
        s.height = 0;
        s.container = Container::Gif;
        assert_eq!(output_size(&p, &s), (480, 270));
    }

    #[test]
    fn size_mode_computes_bitrate() {
        // 50 MB over 100 s with 128k audio.
        let k = bitrate_for_size(50.0, 100.0, 128);
        assert!((3700..3900).contains(&k), "{k}");
    }

    #[test]
    fn amf_uses_cqp() {
        let args = video_encoder_args("h264_amf", &settings(), 10.0, None);
        assert!(args.windows(2).any(|w| w[0] == "-rc" && w[1] == "cqp"));
        assert!(args.windows(2).any(|w| w[0] == "-qp_i" && w[1] == "24"));
    }

    #[test]
    fn copy_path_eligibility() {
        let p = project(vec![clip("c1", "m1", "v1", 0.0, 0.0, 4.0), clip("c2", "m2", "v1", 4.0, 1.0, 5.0)]);
        assert!(copy_eligibility(&p, &settings()).is_ok());

        let mut sped = p.clone();
        sped.clips[1].speed = 2.0;
        assert!(copy_eligibility(&sped, &settings()).is_err());

        let mut two_tracks = p.clone();
        two_tracks.clips[1].track_id = "v2".into();
        assert!(copy_eligibility(&two_tracks, &settings()).is_err());

        let mut gap = p.clone();
        gap.clips[1].start = 6.0;
        assert!(copy_eligibility(&gap, &settings()).is_err());

        let mut other_fmt = p.clone();
        other_fmt.media[1].info.width = 1280;
        assert!(copy_eligibility(&other_fmt, &settings()).is_err());

        let segs = copy_segments(&p, (0.0, 8.0), &|_, t| t);
        assert_eq!(segs[1], CopySegment { path: "C:/media/m2.mp4".into(), start: 1.0, duration: 4.0 });
        // Snapping the in-point to an earlier keyframe keeps the same out-point.
        let snapped = copy_segments(&p, (0.0, 8.0), &|_, t| (t / 2.0).floor() * 2.0);
        assert_eq!((snapped[1].start, snapped[1].duration), (0.0, 5.0));
    }

    #[test]
    fn chunks_are_frame_aligned_and_cover_range() {
        let c = chunk_ranges((0.0, 10.0), 3, 30.0);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].0, 0.0);
        assert_eq!(c[2].1, 10.0);
        for w in c.windows(2) {
            assert_eq!(w[0].1, w[1].0);
            let frames = w[0].1 * 30.0;
            assert!((frames - frames.round()).abs() < 1e-9);
        }
    }
}
