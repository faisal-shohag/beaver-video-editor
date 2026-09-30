// Mirrors src-tauri/src/model.rs (serde camelCase).

export type TrackKind = "video" | "audio";

export interface MediaInfo {
  path: string;
  name: string;
  duration: number;
  sizeBytes: number;
  formatName: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  pixFmt: string;
  acodec: string;
  sampleRate: number;
  channels: number;
  rotation: number;
}

export interface MediaItem extends MediaInfo {
  id: string;
  /** Lightweight preview copy (never used for export). */
  proxyPath?: string | null;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  volume: number;
}

export interface Clip {
  id: string;
  mediaId: string;
  trackId: string;
  /** Timeline position (s). */
  start: number;
  /** Source in/out points (s). */
  in: number;
  out: number;
  speed: number;
  preservePitch: boolean;
  volume: number;
  opacity: number;
  /** Centre offset as a fraction of frame width/height. */
  x: number;
  y: number;
  scale: number;
  /** Video clip whose audio lives on an audio track. */
  audioDetached: boolean;
}

export interface Project {
  name: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
}

export type Container = "mp4" | "mov" | "mkv" | "webm" | "gif" | "mp3" | "m4a" | "wav";
export type VideoCodec = "h264" | "hevc" | "av1" | "vp9" | "prores";
export type AudioCodec = "aac" | "opus" | "mp3" | "pcm" | "none";
export type Quality = "high" | "medium" | "small";
export type QualityMode = "crf" | "bitrate" | "size";
export type SpeedPreset = "fastest" | "balanced" | "quality";
/** turbo = fastest measured strategy, render = best compression (CPU), copy = lossless stream copy. */
export type ExportMode = "render" | "copy" | "turbo";

export interface ExportSettings {
  outputPath: string;
  container: Container;
  videoCodec: VideoCodec;
  encoder: string;
  width: number;
  height: number;
  fps: number;
  qualityMode: QualityMode;
  quality: Quality;
  bitrateKbps: number;
  targetSizeMb: number;
  speedPreset: SpeedPreset;
  audioCodec: AudioCodec;
  audioBitrateKbps: number;
  rangeStart: number;
  rangeEnd: number;
  mode: ExportMode;
}

export interface EncoderResult {
  codec: VideoCodec;
  encoder: string;
  hardware: boolean;
  ok: boolean;
  fps: number;
  error?: string | null;
}

export interface EncoderReport {
  version: number;
  ffmpegVersion: string;
  results: EncoderResult[];
  best: Partial<Record<VideoCodec, string>>;
}

export interface Thumbnails {
  path: string;
  count: number;
  tileWidth: number;
  tileHeight: number;
}

export interface ProbeResult {
  path: string;
  info: MediaInfo | null;
  error: string | null;
}

export interface JoinCheck {
  compatible: boolean;
  reason: string | null;
  totalDuration: number;
  infos: MediaInfo[];
}

export interface ExportProgressEvent {
  jobId: string;
  progress: number;
  fps: number;
  speed: number;
  etaSecs: number;
  stage: string;
}

export interface ExportDoneEvent {
  jobId: string;
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  output: string;
  elapsedSecs: number;
  sizeBytes: number;
  encoder: string;
}
