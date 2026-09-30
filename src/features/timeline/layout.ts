import type { Track } from "@/lib/types";

export const RULER_H = 28;
export const VIDEO_H = 66;
export const AUDIO_H = 52;
export const DIVIDER_H = 8;
export const HEADER_W = 132;
export const EDGE_PX = 7;

export interface Lane {
  track: Track;
  y: number;
  h: number;
  /** Index among tracks of the same kind in project order (V1 = 0). */
  kindIndex: number;
}

/** Display order: highest video track on top (it draws over the others), then audio A1..An. */
export function computeLanes(tracks: Track[]): { lanes: Lane[]; height: number; dividerY: number } {
  const videos = tracks.filter((t) => t.kind === "video");
  const audios = tracks.filter((t) => t.kind === "audio");
  const lanes: Lane[] = [];
  let y = 0;
  for (let i = videos.length - 1; i >= 0; i--) {
    lanes.push({ track: videos[i], y, h: VIDEO_H, kindIndex: i });
    y += VIDEO_H;
  }
  const dividerY = y;
  y += DIVIDER_H;
  audios.forEach((t, i) => {
    lanes.push({ track: t, y, h: AUDIO_H, kindIndex: i });
    y += AUDIO_H;
  });
  return { lanes, height: y + 24, dividerY };
}

export function laneAt(lanes: Lane[], y: number): Lane | undefined {
  return lanes.find((l) => y >= l.y && y < l.y + l.h);
}

/** Pick a ruler step so labels are at least ~90px apart. */
export function rulerStep(pxPerSec: number, fps: number): { major: number; minor: number } {
  const steps = [1 / fps, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = steps.find((s) => s * pxPerSec >= 90) ?? 3600;
  const minorDiv = major >= 60 ? 6 : major >= 1 ? (major === 15 || major === 30 ? 3 : 5) : 5;
  return { major, minor: major / minorDiv };
}
