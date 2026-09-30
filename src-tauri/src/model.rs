//! Serde mirror of the TypeScript project model (`src/lib/types.ts`).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub size_bytes: u64,
    pub format_name: String,
    pub has_video: bool,
    pub has_audio: bool,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub vcodec: String,
    pub pix_fmt: String,
    pub acodec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub rotation: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    #[serde(flatten)]
    pub info: MediaInfo,
    #[serde(default)]
    pub proxy_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    pub muted: bool,
    pub hidden: bool,
    pub locked: bool,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    pub track_id: String,
    /// Position on the timeline, seconds.
    pub start: f64,
    /// Source in point, seconds.
    #[serde(rename = "in")]
    pub in_point: f64,
    /// Source out point, seconds.
    #[serde(rename = "out")]
    pub out_point: f64,
    pub speed: f64,
    pub preserve_pitch: bool,
    pub volume: f64,
    pub opacity: f64,
    /// Offset of the clip centre from the frame centre, as a fraction of frame width/height.
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    /// Video clip whose audio was moved to an audio track (so it is silent itself).
    #[serde(default)]
    pub audio_detached: bool,
}

impl Clip {
    pub fn duration(&self) -> f64 {
        (self.out_point - self.in_point) / self.speed
    }
    pub fn end(&self) -> f64 {
        self.start + self.duration()
    }
    pub fn has_transform(&self) -> bool {
        self.x.abs() > 1e-6 || self.y.abs() > 1e-6 || (self.scale - 1.0).abs() > 1e-6
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub sample_rate: u32,
    pub media: Vec<MediaItem>,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
}

impl Project {
    pub fn media(&self, id: &str) -> Option<&MediaItem> {
        self.media.iter().find(|m| m.id == id)
    }
    pub fn track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }
    pub fn duration(&self) -> f64 {
        self.clips.iter().map(|c| c.end()).fold(0.0, f64::max)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Mov,
    Mkv,
    Webm,
    Gif,
    Mp3,
    M4a,
    Wav,
}

impl Container {
    pub fn is_audio_only(self) -> bool {
        matches!(self, Container::Mp3 | Container::M4a | Container::Wav)
    }
    pub fn ext(self) -> &'static str {
        match self {
            Container::Mp4 => "mp4",
            Container::Mov => "mov",
            Container::Mkv => "mkv",
            Container::Webm => "webm",
            Container::Gif => "gif",
            Container::Mp3 => "mp3",
            Container::M4a => "m4a",
            Container::Wav => "wav",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    Hevc,
    Av1,
    Vp9,
    Prores,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Aac,
    Opus,
    Mp3,
    Pcm,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    High,
    Medium,
    Small,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QualityMode {
    Crf,
    Bitrate,
    Size,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeedPreset {
    Fastest,
    Balanced,
    Quality,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportMode {
    /// Full re-encode through the filter graph.
    Render,
    /// Lossless stream copy (only valid for simple single-track timelines).
    Copy,
    /// Fastest measured strategy: GPU encoder single pass when available,
    /// parallel chunks for encoders that scale poorly across threads (VP9).
    Turbo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub output_path: String,
    pub container: Container,
    pub video_codec: VideoCodec,
    /// "auto" or a concrete FFmpeg encoder name.
    pub encoder: String,
    /// 0 = project size.
    pub width: u32,
    pub height: u32,
    /// 0 = project fps.
    pub fps: f64,
    pub quality_mode: QualityMode,
    pub quality: Quality,
    pub bitrate_kbps: u32,
    pub target_size_mb: f64,
    pub speed_preset: SpeedPreset,
    pub audio_codec: AudioCodec,
    pub audio_bitrate_kbps: u32,
    pub range_start: f64,
    /// <= range_start means "until end of timeline".
    pub range_end: f64,
    pub mode: ExportMode,
}
