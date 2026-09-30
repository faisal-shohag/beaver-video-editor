import type { AudioCodec, Container, ExportSettings, VideoCodec } from "@/lib/types";

export interface Preset {
  id: string;
  name: string;
  description: string;
  settings: Partial<ExportSettings>;
  custom?: boolean;
}

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "youtube-1080",
    name: "YouTube 1080p",
    description: "H.264 · high quality",
    settings: { container: "mp4", videoCodec: "h264", width: 0, height: 1080, quality: "high", qualityMode: "crf", audioCodec: "aac", audioBitrateKbps: 192, mode: "turbo", speedPreset: "balanced" },
  },
  {
    id: "youtube-4k",
    name: "YouTube 4K",
    description: "HEVC · GPU fast",
    settings: { container: "mp4", videoCodec: "hevc", width: 0, height: 2160, quality: "high", qualityMode: "crf", audioCodec: "aac", audioBitrateKbps: 256, mode: "turbo", speedPreset: "balanced" },
  },
  {
    id: "vertical",
    name: "Reels / TikTok / Shorts",
    description: "1080×1920 vertical · H.264",
    settings: { container: "mp4", videoCodec: "h264", width: 1080, height: 1920, quality: "high", qualityMode: "crf", audioCodec: "aac", audioBitrateKbps: 192, mode: "turbo", speedPreset: "balanced" },
  },
  {
    id: "small",
    name: "Small file (chat apps)",
    description: "720p · 25 MB target",
    settings: { container: "mp4", videoCodec: "h264", width: 0, height: 720, qualityMode: "size", targetSizeMb: 25, audioCodec: "aac", audioBitrateKbps: 96, mode: "render", speedPreset: "balanced" },
  },
  {
    id: "draft",
    name: "Fast draft",
    description: "720p · fastest settings",
    settings: { container: "mp4", videoCodec: "h264", width: 0, height: 720, quality: "small", qualityMode: "crf", audioCodec: "aac", audioBitrateKbps: 128, mode: "turbo", speedPreset: "fastest" },
  },
  {
    id: "hevc-archive",
    name: "HEVC (half the size)",
    description: "Source resolution · H.265",
    settings: { container: "mp4", videoCodec: "hevc", width: 0, height: 0, quality: "medium", qualityMode: "crf", audioCodec: "aac", audioBitrateKbps: 192, mode: "turbo", speedPreset: "balanced" },
  },
  {
    id: "av1",
    name: "AV1 (smallest)",
    description: "Modern codec · SVT-AV1",
    settings: { container: "mp4", videoCodec: "av1", width: 0, height: 0, quality: "medium", qualityMode: "crf", audioCodec: "aac", audioBitrateKbps: 160, mode: "turbo", speedPreset: "balanced" },
  },
  {
    id: "webm",
    name: "Web (WebM VP9)",
    description: "VP9 + Opus",
    settings: { container: "webm", videoCodec: "vp9", width: 0, height: 1080, quality: "medium", qualityMode: "crf", audioCodec: "opus", audioBitrateKbps: 128, mode: "turbo", speedPreset: "fastest" },
  },
  {
    id: "master",
    name: "Editing master",
    description: "ProRes 422 HQ · PCM (large)",
    settings: { container: "mov", videoCodec: "prores", width: 0, height: 0, quality: "high", qualityMode: "crf", audioCodec: "pcm", mode: "turbo", speedPreset: "balanced" },
  },
  {
    id: "gif",
    name: "Animated GIF",
    description: "480px wide · 15 fps",
    settings: { container: "gif", width: 0, height: 0, fps: 0, audioCodec: "none", mode: "render" },
  },
  {
    id: "mp3",
    name: "Audio · MP3",
    description: "320 kbps",
    settings: { container: "mp3", audioCodec: "mp3", audioBitrateKbps: 320, mode: "render" },
  },
  {
    id: "wav",
    name: "Audio · WAV",
    description: "Uncompressed 16-bit",
    settings: { container: "wav", audioCodec: "pcm", mode: "render" },
  },
];

export const CONTAINERS: { value: Container; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "mov", label: "MOV" },
  { value: "mkv", label: "MKV" },
  { value: "webm", label: "WebM" },
  { value: "gif", label: "GIF" },
  { value: "mp3", label: "MP3 (audio)" },
  { value: "m4a", label: "M4A (audio)" },
  { value: "wav", label: "WAV (audio)" },
];

export const CODEC_LABEL: Record<VideoCodec, string> = {
  h264: "H.264 / AVC",
  hevc: "H.265 / HEVC",
  av1: "AV1",
  vp9: "VP9",
  prores: "Apple ProRes",
};

export const VIDEO_CODECS_FOR: Record<Container, VideoCodec[]> = {
  mp4: ["h264", "hevc", "av1"],
  mov: ["h264", "hevc", "prores"],
  mkv: ["h264", "hevc", "av1", "vp9"],
  webm: ["vp9", "av1"],
  gif: [],
  mp3: [],
  m4a: [],
  wav: [],
};

export const AUDIO_CODECS_FOR: Record<Container, AudioCodec[]> = {
  mp4: ["aac", "mp3", "none"],
  mov: ["aac", "pcm", "none"],
  mkv: ["aac", "opus", "mp3", "pcm", "none"],
  webm: ["opus", "none"],
  gif: ["none"],
  mp3: ["mp3"],
  m4a: ["aac"],
  wav: ["pcm"],
};

export const AUDIO_LABEL: Record<AudioCodec, string> = {
  aac: "AAC",
  opus: "Opus",
  mp3: "MP3",
  pcm: "PCM (uncompressed)",
  none: "No audio",
};

export const EXT_FOR: Record<Container, string> = {
  mp4: "mp4",
  mov: "mov",
  mkv: "mkv",
  webm: "webm",
  gif: "gif",
  mp3: "mp3",
  m4a: "m4a",
  wav: "wav",
};

export function defaultSettings(): ExportSettings {
  return {
    outputPath: "",
    container: "mp4",
    videoCodec: "h264",
    encoder: "auto",
    width: 0,
    height: 0,
    fps: 0,
    qualityMode: "crf",
    quality: "high",
    bitrateKbps: 8000,
    targetSizeMb: 50,
    speedPreset: "balanced",
    audioCodec: "aac",
    audioBitrateKbps: 192,
    rangeStart: 0,
    rangeEnd: 0,
    mode: "turbo",
  };
}

/** Make codec choices consistent with the container. */
export function normalise(s: ExportSettings): ExportSettings {
  const out = { ...s };
  const vc = VIDEO_CODECS_FOR[out.container];
  if (vc.length && !vc.includes(out.videoCodec)) {
    out.videoCodec = vc[0];
    out.encoder = "auto";
  }
  const ac = AUDIO_CODECS_FOR[out.container];
  if (!ac.includes(out.audioCodec)) out.audioCodec = ac[0];
  // GIF and audio-only exports are single-pass renders.
  if (!vc.length) out.mode = "render";
  return out;
}

const USER_KEY = "beaver.userPresets";
const LAST_KEY = "beaver.lastExport";

export function loadUserPresets(): Preset[] {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveUserPresets(p: Preset[]) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export function loadLastSettings(): Partial<ExportSettings> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveLastSettings(s: ExportSettings) {
  try {
    // Output path and range are per-export; everything else is a preference.
    const rest: Partial<ExportSettings> = { ...s };
    delete rest.outputPath;
    delete rest.rangeStart;
    delete rest.rangeEnd;
    localStorage.setItem(LAST_KEY, JSON.stringify(rest));
  } catch {
    /* storage unavailable */
  }
}
