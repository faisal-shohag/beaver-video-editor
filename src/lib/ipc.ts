import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  EncoderReport,
  ExportSettings,
  JoinCheck,
  MediaInfo,
  ProbeResult,
  Project,
  Thumbnails,
} from "./types";

export const ipc = {
  probeMedia: (paths: string[]) => invoke<ProbeResult[]>("probe_media", { paths }),
  checkNeedsProxy: (info: MediaInfo) => invoke<boolean>("check_needs_proxy", { info }),
  generateProxy: (info: MediaInfo) => invoke<string>("generate_proxy", { info }),
  generateThumbnails: (info: MediaInfo) => invoke<Thumbnails>("generate_thumbnails", { info }),
  generateWaveform: (path: string) => invoke<number[]>("generate_waveform", { path }),
  getEncoders: (force = false) => invoke<EncoderReport>("get_encoders", { force }),
  startExport: (jobId: string, project: Project, settings: ExportSettings) =>
    invoke<void>("start_export", { jobId, project, settings }),
  cancelExport: (jobId: string) => invoke<void>("cancel_export", { jobId }),
  checkCopyEligible: (project: Project, settings: ExportSettings) =>
    invoke<void>("check_copy_eligible", { project, settings }),
  quickJoinCheck: (paths: string[]) => invoke<JoinCheck>("quick_join_check", { paths }),
  quickJoin: (jobId: string, paths: string[], output: string) =>
    invoke<void>("quick_join", { jobId, paths, output }),
  saveProject: (path: string, contents: string) => invoke<void>("save_project", { path, contents }),
  loadProject: (path: string) => invoke<string>("load_project", { path }),
  writeAutosave: (contents: string) => invoke<void>("write_autosave", { contents }),
  readAutosave: () => invoke<string | null>("read_autosave"),
  clearAutosave: () => invoke<void>("clear_autosave"),
  filesExist: (paths: string[]) => invoke<boolean[]>("files_exist", { paths }),
};

export const fileUrl = (path: string) => convertFileSrc(path);

export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mts", "m2ts", "ts", "wmv", "flv", "3gp", "mpg", "mpeg", "mxf"];
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "aif", "aiff"];
