// Pure timeline edits. Each op mutates a Project draft (used with immer's produce),
// so undo/redo is just snapshotting and every op is unit-testable.
import { uid } from "@/lib/time";
import type { Clip, MediaItem, Project, Track, TrackKind } from "@/lib/types";

export const MIN_CLIP = 1 / 60;
const EPS = 1e-6;

export const clipDuration = (c: Clip) => (c.out - c.in) / c.speed;
export const clipEnd = (c: Clip) => c.start + clipDuration(c);
export const projectDuration = (p: Project) => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

export const mediaOf = (p: Project, c: Clip) => p.media.find((m) => m.id === c.mediaId);
export const trackOf = (p: Project, id: string) => p.tracks.find((t) => t.id === id);
export const clipsOnTrack = (p: Project, trackId: string) =>
  p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);

export function createProject(name = "Untitled"): Project {
  return {
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    sampleRate: 48000,
    media: [],
    tracks: [newTrack("video", "V1"), newTrack("video", "V2"), newTrack("audio", "A1"), newTrack("audio", "A2")],
    clips: [],
  };
}

export function newTrack(kind: TrackKind, name: string): Track {
  return { id: uid("t_"), kind, name, muted: false, hidden: false, locked: false, volume: 1 };
}

export function newClip(media: MediaItem, trackId: string, start: number, extra: Partial<Clip> = {}): Clip {
  return {
    id: uid("c_"),
    mediaId: media.id,
    trackId,
    start,
    in: 0,
    out: media.duration,
    speed: 1,
    preservePitch: true,
    volume: 1,
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    audioDetached: false,
    ...extra,
  };
}

export function trackKindFor(media: MediaItem): TrackKind {
  return media.hasVideo ? "video" : "audio";
}

/** True if [start, end) on `trackId` is free of clips (except `ignore`). */
export function isFree(p: Project, trackId: string, start: number, end: number, ignore: Set<string> = new Set()) {
  return !p.clips.some(
    (c) => c.trackId === trackId && !ignore.has(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS,
  );
}

/** Nearest start ≥ 0 where a clip of `dur` fits on the track. */
export function findFreeStart(p: Project, trackId: string, wanted: number, dur: number, ignore = new Set<string>()) {
  const start = Math.max(0, wanted);
  if (isFree(p, trackId, start, start + dur, ignore)) return start;
  const others = p.clips.filter((c) => c.trackId === trackId && !ignore.has(c.id));
  const candidates = new Set<number>();
  for (const c of others) {
    candidates.add(clipEnd(c));
    candidates.add(c.start - dur);
  }
  let best = Infinity;
  let bestDist = Infinity;
  for (const s of candidates) {
    if (s < -EPS) continue;
    const cs = Math.max(0, s);
    if (!isFree(p, trackId, cs, cs + dur, ignore)) continue;
    const d = Math.abs(cs - start);
    if (d < bestDist) {
      bestDist = d;
      best = cs;
    }
  }
  return Number.isFinite(best) ? best : others.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function trackEnd(p: Project, trackId: string) {
  return p.clips.filter((c) => c.trackId === trackId).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function firstTrack(p: Project, kind: TrackKind) {
  return p.tracks.find((t) => t.kind === kind);
}

/** Place media on the timeline. Returns created clip ids. */
export function insertMedia(p: Project, media: MediaItem, trackId: string | null, start: number): string[] {
  const kind = trackKindFor(media);
  let track = trackId ? trackOf(p, trackId) : undefined;
  if (!track || track.kind !== kind) track = firstTrack(p, kind);
  if (!track) {
    track = newTrack(kind, `${kind === "video" ? "V" : "A"}${p.tracks.filter((t) => t.kind === kind).length + 1}`);
    p.tracks.push(track);
  }
  const clip = newClip(media, track.id, 0);
  clip.start = findFreeStart(p, track.id, start, clipDuration(clip));
  p.clips.push(clip);
  return [clip.id];
}

/** Joiner: append media back-to-back at the end of their first track. */
export function appendMedia(p: Project, media: MediaItem[]): string[] {
  const ids: string[] = [];
  for (const m of media) {
    const track = firstTrack(p, trackKindFor(m));
    const at = track ? trackEnd(p, track.id) : 0;
    ids.push(...insertMedia(p, m, track?.id ?? null, at));
  }
  return ids;
}

/** Split every listed clip that spans `t`. Returns ids of the new right-hand clips. */
export function splitClips(p: Project, ids: string[], t: number): string[] {
  const created: string[] = [];
  for (const id of ids) {
    const c = p.clips.find((x) => x.id === id);
    if (!c) continue;
    const track = trackOf(p, c.trackId);
    if (track?.locked) continue;
    if (t <= c.start + MIN_CLIP || t >= clipEnd(c) - MIN_CLIP) continue;
    const srcT = c.in + (t - c.start) * c.speed;
    const right: Clip = { ...c, id: uid("c_"), start: t, in: srcT };
    c.out = srcT;
    p.clips.push(right);
    created.push(right.id);
  }
  return created;
}

/** Clips on unlocked tracks under time `t`. */
export function clipsAt(p: Project, t: number): Clip[] {
  return p.clips.filter((c) => c.start < t - EPS && clipEnd(c) > t + EPS && !trackOf(p, c.trackId)?.locked);
}

export function deleteClips(p: Project, ids: string[], ripple: boolean) {
  const doomed = p.clips.filter((c) => ids.includes(c.id) && !trackOf(p, c.trackId)?.locked);
  if (ripple) {
    // Close each gap on its own track, processing right-to-left so shifts don't compound wrongly.
    for (const d of [...doomed].sort((a, b) => b.start - a.start)) {
      const dur = clipDuration(d);
      for (const c of p.clips) {
        if (c.trackId === d.trackId && c.id !== d.id && c.start >= clipEnd(d) - EPS) c.start = Math.max(0, c.start - dur);
      }
    }
  }
  const gone = new Set(doomed.map((c) => c.id));
  p.clips = p.clips.filter((c) => !gone.has(c.id));
}

/** Cutter: remove [a, b) from all unlocked tracks, optionally closing the gap. */
export function deleteRange(p: Project, a: number, b: number, ripple: boolean) {
  if (b - a < MIN_CLIP) return;
  const unlocked = (c: Clip) => !trackOf(p, c.trackId)?.locked;
  splitClips(p, p.clips.filter(unlocked).map((c) => c.id), a);
  splitClips(p, p.clips.filter(unlocked).map((c) => c.id), b);
  p.clips = p.clips.filter((c) => !(unlocked(c) && c.start >= a - EPS && clipEnd(c) <= b + EPS));
  if (ripple) {
    for (const c of p.clips) if (unlocked(c) && c.start >= b - EPS) c.start -= b - a;
  }
}

function neighbours(p: Project, c: Clip) {
  const others = p.clips.filter((o) => o.trackId === c.trackId && o.id !== c.id);
  const prevEnd = others.filter((o) => clipEnd(o) <= c.start + EPS).reduce((m, o) => Math.max(m, clipEnd(o)), 0);
  const nextStart = others.filter((o) => o.start >= clipEnd(c) - EPS).reduce((m, o) => Math.min(m, o.start), Infinity);
  return { prevEnd, nextStart };
}

/** Drag the left edge to timeline time `t` (clamped by media start and previous clip). */
export function trimStart(p: Project, id: string, t: number) {
  const c = p.clips.find((x) => x.id === id);
  if (!c) return;
  const { prevEnd } = neighbours(p, c);
  const minT = Math.max(prevEnd, c.start - c.in / c.speed);
  const maxT = clipEnd(c) - MIN_CLIP;
  const nt = Math.min(Math.max(t, minT), maxT);
  c.in += (nt - c.start) * c.speed;
  c.start = nt;
}

/** Drag the right edge to timeline time `t` (clamped by media end and next clip). */
export function trimEnd(p: Project, id: string, t: number) {
  const c = p.clips.find((x) => x.id === id);
  if (!c) return;
  const media = mediaOf(p, c);
  const { nextStart } = neighbours(p, c);
  const mediaEnd = c.start + ((media?.duration ?? c.out) - c.in) / c.speed;
  const maxT = Math.min(nextStart, mediaEnd);
  const nt = Math.max(Math.min(t, maxT), c.start + MIN_CLIP);
  c.out = c.in + (nt - c.start) * c.speed;
}

/** Trim a clip's head/tail to the playhead (Q / W). */
export function trimToPlayhead(p: Project, ids: string[], t: number, side: "start" | "end") {
  for (const c of p.clips.filter((x) => ids.includes(x.id))) {
    if (t <= c.start || t >= clipEnd(c)) continue;
    if (side === "start") trimStart(p, c.id, t);
    else trimEnd(p, c.id, t);
  }
}

/**
 * Move clips by `dt` seconds and `laneDelta` lanes (within tracks of the same kind).
 * Overlaps are allowed while dragging; call `resolveDrop` on release.
 */
export function moveClips(p: Project, ids: string[], dt: number, laneDelta: number) {
  const moving = p.clips.filter((c) => ids.includes(c.id));
  const minStart = Math.min(...moving.map((c) => c.start));
  const shift = Math.max(dt, -minStart);
  for (const c of moving) {
    c.start += shift;
    if (laneDelta !== 0) {
      const track = trackOf(p, c.trackId);
      if (!track) continue;
      const lanes = p.tracks.filter((t) => t.kind === track.kind);
      const idx = lanes.findIndex((t) => t.id === track.id);
      const target = lanes[Math.min(Math.max(idx + laneDelta, 0), lanes.length - 1)];
      if (!target.locked) c.trackId = target.id;
    }
  }
}

export function hasOverlap(p: Project, ids: string[]) {
  const set = new Set(ids);
  return p.clips
    .filter((c) => set.has(c.id))
    .some((c) =>
      p.clips.some((o) => o.id !== c.id && o.trackId === c.trackId && o.start < clipEnd(c) - EPS && clipEnd(o) > c.start + EPS),
    );
}

/**
 * After a drag: a single clip slides to the nearest free spot; a group that
 * overlaps is rejected (returns false so the caller can revert).
 */
export function resolveDrop(p: Project, ids: string[]): boolean {
  if (!hasOverlap(p, ids)) return true;
  if (ids.length !== 1) return false;
  const c = p.clips.find((x) => x.id === ids[0]);
  if (!c) return false;
  c.start = findFreeStart(p, c.trackId, c.start, clipDuration(c), new Set(ids));
  return true;
}

/**
 * Change speed keeping the clip start. Later clips on the track follow the new end:
 * pushed when it grows into them, pulled back when they were butted against it.
 */
export function setSpeed(p: Project, ids: string[], speed: number) {
  const s = Math.min(Math.max(speed, 0.1), 16);
  for (const c of p.clips.filter((x) => ids.includes(x.id))) {
    const oldEnd = clipEnd(c);
    c.speed = s;
    const newEnd = clipEnd(c);
    const later = p.clips.filter((o) => o.trackId === c.trackId && o.id !== c.id && o.start >= oldEnd - EPS);
    if (!later.length) continue;
    const firstLater = later.reduce((m, o) => Math.min(m, o.start), Infinity);
    let shift = 0;
    if (newEnd > firstLater) shift = newEnd - firstLater;
    else if (firstLater - oldEnd < 1e-3) shift = newEnd - oldEnd;
    for (const o of later) o.start += shift;
  }
}

/** Turn voice enhancement on/off. A new model/strength clears the path until it's rendered. */
export function setEnhance(p: Project, ids: string[], enhance: Clip["enhance"]) {
  for (const c of p.clips) {
    if (!ids.includes(c.id)) continue;
    if (!enhance) c.enhance = null;
    else if (c.enhance?.model !== enhance.model || c.enhance?.strength !== enhance.strength || enhance.path) {
      c.enhance = { ...enhance };
    }
  }
}

/** After a render finishes: attach the file to every clip of that media with the same settings. */
export function attachEnhanced(p: Project, mediaPath: string, model: string, strength: string, path: string) {
  const mediaIds = new Set(p.media.filter((m) => m.path === mediaPath).map((m) => m.id));
  for (const c of p.clips) {
    if (mediaIds.has(c.mediaId) && c.enhance?.model === model && c.enhance.strength === strength) {
      c.enhance.path = path;
    }
  }
}

export function updateClips(p: Project, ids: string[], patch: Partial<Clip>) {
  for (const c of p.clips) if (ids.includes(c.id)) Object.assign(c, patch);
}

/** Move a video clip's audio onto an audio track (same timing). Returns the new clip id. */
export function detachAudio(p: Project, id: string): string | null {
  const c = p.clips.find((x) => x.id === id);
  const media = c && mediaOf(p, c);
  const track = c && trackOf(p, c.trackId);
  if (!c || !media?.hasAudio || track?.kind !== "video" || c.audioDetached) return null;
  let target = p.tracks.find((t) => t.kind === "audio" && !t.locked && isFree(p, t.id, c.start, clipEnd(c)));
  if (!target) {
    target = newTrack("audio", `A${p.tracks.filter((t) => t.kind === "audio").length + 1}`);
    p.tracks.push(target);
  }
  const audio: Clip = { ...c, id: uid("c_"), trackId: target.id, opacity: 1, x: 0, y: 0, scale: 1, audioDetached: false };
  c.audioDetached = true;
  p.clips.push(audio);
  return audio.id;
}

export function addTrack(p: Project, kind: TrackKind): string {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const t = newTrack(kind, `${kind === "video" ? "V" : "A"}${n}`);
  // Keep video tracks grouped before audio tracks.
  if (kind === "video") {
    const lastVideo = p.tracks.map((x) => x.kind).lastIndexOf("video");
    p.tracks.splice(lastVideo + 1, 0, t);
  } else {
    p.tracks.push(t);
  }
  return t.id;
}

export function removeTrack(p: Project, id: string) {
  const t = trackOf(p, id);
  if (!t || p.tracks.filter((x) => x.kind === t.kind).length <= 1) return;
  p.tracks = p.tracks.filter((x) => x.id !== id);
  p.clips = p.clips.filter((c) => c.trackId !== id);
  let n = 0;
  for (const x of p.tracks) if (x.kind === t.kind) x.name = `${t.kind === "video" ? "V" : "A"}${++n}`;
}

/** Times that dragged edges should stick to. */
export function snapPoints(p: Project, exclude: Set<string>, extra: number[]): number[] {
  const pts = [0, ...extra];
  for (const c of p.clips) {
    if (exclude.has(c.id)) continue;
    pts.push(c.start, clipEnd(c));
  }
  return pts;
}

/** Closest snap point within `threshold` seconds, or null. */
export function nearestSnap(t: number, points: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestD = threshold;
  for (const s of points) {
    const d = Math.abs(s - t);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Common frame rates snap to their canonical value (29.97 stays 29.97). */
export function normaliseFps(fps: number): number {
  const known = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
  const hit = known.find((k) => Math.abs(k - fps) < 0.02);
  return hit ?? Math.round(fps * 100) / 100;
}
