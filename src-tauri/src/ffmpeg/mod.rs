//! Locating and launching the bundled FFmpeg binaries.
pub mod graph;
pub mod probe;
pub mod progress;

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn resolve(name: &str) -> PathBuf {
    // Tauri copies sidecars next to the app executable (dev and bundled builds alike).
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        let candidate = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

pub fn ffmpeg_path() -> &'static PathBuf {
    static P: OnceLock<PathBuf> = OnceLock::new();
    P.get_or_init(|| resolve("ffmpeg"))
}

pub fn ffprobe_path() -> &'static PathBuf {
    static P: OnceLock<PathBuf> = OnceLock::new();
    P.get_or_init(|| resolve("ffprobe"))
}

fn hidden(mut cmd: Command) -> Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub fn ffmpeg() -> Command {
    let mut cmd = hidden(Command::new(ffmpeg_path()));
    cmd.args(["-hide_banner", "-nostdin"]);
    cmd
}

pub fn ffprobe() -> Command {
    let mut cmd = hidden(Command::new(ffprobe_path()));
    cmd.arg("-hide_banner");
    cmd
}

/// Run FFmpeg to completion, returning stderr on failure.
pub fn run_ffmpeg(args: &[String]) -> Result<(), String> {
    let out = ffmpeg().args(args).output().map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(last_lines(&String::from_utf8_lossy(&out.stderr), 6))
    }
}

pub fn last_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Format seconds for FFmpeg arguments: fixed precision, trailing zeros trimmed.
pub fn secs(x: f64) -> String {
    let mut s = format!("{:.6}", x.max(0.0));
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}

/// Format a plain number (factors, volumes).
pub fn num(x: f64) -> String {
    let mut s = format!("{:.6}", x);
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    if s == "-0" {
        s = "0".into();
    }
    s
}
