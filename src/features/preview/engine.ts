// Real-time multi-track preview without re-encoding.
//
// Each clip under (or about to reach) the playhead gets a hidden <video> element
// seeked to the matching source time. Every animation frame the visible video
// tracks are composited onto one canvas (V1 at the bottom). While playing, the
// timeline clock is slaved to the lowest active video element so picture and
// sound never drift; other elements are nudged back when they wander.
import { fileUrl } from "@/lib/ipc";
import type { Clip, MediaItem, Project } from "@/lib/types";
import { clipEnd, projectDuration } from "@/store/ops";
import { getProject, useProject } from "@/store/project";
import { runtime, useRuntime } from "@/store/runtime";
import { ui, useUi } from "@/store/ui";

interface Slot {
  el: HTMLVideoElement;
  src: string;
  lastUsed: number;
  /** Enhanced voice track, played instead of the media's own audio. */
  voice?: { el: HTMLAudioElement; src: string };
}

/**
 * Keep a media element at `desired` source time: play/pause, rate, drift correction.
 * With `nudge` (the enhanced-voice element), small drift is pulled in by adjusting the playback
 * rate up to ±5% instead of seeking, so lip sync stays within a frame without audible jumps.
 */
function drive(el: HTMLMediaElement, desired: number, rate: number, playing: boolean, tolerance: number, nudge = false) {
  if (playing) {
    const drift = el.currentTime - desired;
    let target = rate;
    if (nudge && !el.paused && Math.abs(drift) > 0.005) target = rate * (1 - Math.max(-0.05, Math.min(0.05, drift * 1.5)));
    if (Math.abs(el.playbackRate - target) > 1e-4) el.playbackRate = target;
    if (el.paused) {
      if (Math.abs(drift) > 0.04) el.currentTime = desired;
      el.play().catch(() => {});
    } else if (!el.seeking && Math.abs(drift) > 0.15 * Math.max(1, rate)) {
      el.currentTime = desired;
    }
  } else {
    if (el.playbackRate !== rate) el.playbackRate = rate;
    if (!el.paused) el.pause();
    if (!el.seeking && Math.abs(el.currentTime - desired) > tolerance) el.currentTime = desired;
  }
}

const PRELOAD_AHEAD = 1.5; // seconds
const IDLE_RELEASE_MS = 2500;
const MAX_IDLE_SLOTS = 4; // keeps the iGPU decoder count and RAM low

export class PreviewEngine {
  private ctx: CanvasRenderingContext2D;
  private slots = new Map<string, Slot>();
  private raf = 0;
  private dirty = true;
  private clockT = 0;
  private clockPerf = 0;
  private lastSetPlayhead = -1;
  private unsubs: (() => void)[] = [];
  private frameW = 1920;
  private frameH = 1080;

  constructor(
    private canvas: HTMLCanvasElement,
    private host: HTMLElement,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })!;
    const markDirty = () => (this.dirty = true);
    this.unsubs.push(useProject.subscribe(markDirty), useUi.subscribe(markDirty), useRuntime.subscribe(markDirty));
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    for (const s of this.slots.values()) this.dispose(s);
    this.slots.clear();
  }

  /** Canvas backing size in device pixels; keeps the project aspect ratio. */
  resize(cssW: number, cssH: number) {
    const p = getProject();
    const aspect = p.width / p.height;
    let w = cssW;
    let h = cssW / aspect;
    if (h > cssH) {
      h = cssH;
      w = cssH * aspect;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Never render above project resolution; cap at 1080p-class for the iGPU.
    const scale = Math.min(dpr, p.width / w, 1920 / w);
    this.canvas.style.width = `${Math.round(w)}px`;
    this.canvas.style.height = `${Math.round(h)}px`;
    this.frameW = Math.max(2, Math.round(w * scale));
    this.frameH = Math.max(2, Math.round(h * scale));
    this.canvas.width = this.frameW;
    this.canvas.height = this.frameH;
    this.dirty = true;
  }

  play() {
    const u = ui();
    const p = getProject();
    const end = this.playEnd(p);
    const from = u.playhead >= end - 0.01 ? (u.inPoint ?? 0) : u.playhead;
    this.clockT = from;
    this.clockPerf = performance.now();
    this.setPlayhead(from);
    u.set({ playing: true });
  }

  pause() {
    ui().set({ playing: false, shuttle: 1 });
    for (const s of this.slots.values()) s.el.pause();
  }

  toggle() {
    if (ui().playing) this.pause();
    else this.play();
  }

  private playEnd(p: Project) {
    const u = ui();
    const dur = projectDuration(p);
    if (u.outPoint != null && u.playhead < u.outPoint - 0.01) return Math.min(u.outPoint, dur);
    return dur;
  }

  private setPlayhead(t: number) {
    this.lastSetPlayhead = t;
    ui().seek(t);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    try {
      this.tick(now);
    } catch (e) {
      console.error(e);
    }
  };

  private tick(now: number) {
    const u = ui();
    const p = getProject();
    let t = u.playhead;
    if (u.playing) {
      if (Math.abs(u.playhead - this.lastSetPlayhead) > 1e-6) {
        // User scrubbed while playing: restart the clock from there.
        this.clockT = u.playhead;
        this.clockPerf = now;
      }
      t = this.clockT + ((now - this.clockPerf) / 1000) * u.shuttle;
      const master = this.masterTime(p, t);
      if (master != null && Math.abs(master - t) < 0.3) {
        t = master;
        this.clockT = t;
        this.clockPerf = now;
      }
      const end = this.playEnd(p);
      if (t >= end) {
        t = end;
        this.setPlayhead(t);
        this.pause();
      } else {
        this.setPlayhead(t);
      }
    }
    this.sync(p, t, ui().playing, now);
    if (ui().playing || this.dirty) {
      this.dirty = false;
      this.draw(p, t);
    }
  }

  /** Timeline time implied by the first active video element that is playing smoothly. */
  private masterTime(p: Project, t: number): number | null {
    for (const track of p.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      const c = p.clips.find((x) => x.trackId === track.id && x.start <= t && clipEnd(x) > t);
      if (!c) continue;
      const s = this.slots.get(c.id);
      if (!s || s.el.paused || s.el.seeking || s.el.readyState < 3) return null;
      return c.start + (s.el.currentTime - c.in) / c.speed;
    }
    return null;
  }

  private sourceFor(m: MediaItem): string {
    const useProxy = m.proxyPath && runtime().proxy[m.id] === "ready";
    return fileUrl(useProxy ? m.proxyPath! : m.path);
  }

  private slotFor(c: Clip, m: MediaItem, now: number): Slot {
    const src = this.sourceFor(m);
    let s = this.slots.get(c.id);
    if (s && s.src !== src) {
      // Proxy finished: swap source, keep position.
      const t = s.el.currentTime;
      s.el.src = src;
      s.src = src;
      s.el.currentTime = t;
    }
    if (!s) {
      const el = document.createElement("video");
      el.preload = "auto";
      el.playsInline = true;
      el.disableRemotePlayback = true;
      const mark = () => (this.dirty = true);
      el.addEventListener("seeked", mark);
      el.addEventListener("loadeddata", mark);
      el.addEventListener("canplay", mark);
      el.src = src;
      this.host.appendChild(el);
      s = { el, src, lastUsed: now };
      this.slots.set(c.id, s);
    }
    s.lastUsed = now;
    return s;
  }

  private dispose(s: Slot) {
    for (const el of [s.el, s.voice?.el]) {
      if (!el) continue;
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
    }
    s.voice = undefined;
  }

  /** Attach, swap or drop the enhanced-voice element to match the clip. */
  private syncVoice(s: Slot, c: Clip) {
    const src = c.enhance?.path ? fileUrl(c.enhance.path) : null;
    if (s.voice && s.voice.src !== src) {
      s.voice.el.pause();
      s.voice.el.removeAttribute("src");
      s.voice.el.load();
      s.voice.el.remove();
      s.voice = undefined;
    }
    if (src && !s.voice) {
      const el = document.createElement("audio");
      el.preload = "auto";
      el.src = src;
      this.host.appendChild(el);
      s.voice = { el, src };
    }
  }

  private sync(p: Project, t: number, playing: boolean, now: number) {
    const u = ui();
    const active = new Set<string>();
    const tracks = new Map(p.tracks.map((tr) => [tr.id, tr]));
    const media = new Map(p.media.map((m) => [m.id, m]));
    const tolerance = 0.5 / p.fps;

    for (const c of p.clips) {
      const m = media.get(c.mediaId);
      const track = tracks.get(c.trackId);
      if (!m || !track) continue;
      const end = clipEnd(c);
      const isActive = c.start <= t && t < end;
      const upcoming = playing && c.start > t && c.start - t < PRELOAD_AHEAD;
      if (!isActive && !upcoming) continue;
      // Hidden video tracks still play their audio; skip decoding if they have none.
      if (track.kind === "video" && track.hidden && (!m.hasAudio || c.audioDetached)) continue;
      active.add(c.id);
      const s = this.slotFor(c, m, now);
      const el = s.el;

      if (!isActive) {
        // Preload: park on the first frame so the cut is instant.
        this.syncVoice(s, c);
        for (const media of [el, s.voice?.el]) {
          if (!media) continue;
          if (!media.paused) media.pause();
          if (!media.seeking && Math.abs(media.currentTime - c.in) > tolerance) media.currentTime = c.in;
          media.muted = true;
        }
        continue;
      }

      const desired = c.in + (t - c.start) * c.speed;
      const silent = track.muted || (track.kind === "video" && c.audioDetached) || !m.hasAudio;
      const vol = silent ? 0 : Math.min(1, c.volume * track.volume);
      const rate = Math.min(16, Math.max(0.0625, c.speed * u.shuttle));
      this.syncVoice(s, c);
      // With an enhanced voice, the video element is picture-only unless "hear original" is held.
      const voiceAudible = !!s.voice && !u.hearOriginal;
      for (const [media, audible] of [
        [el, !voiceAudible],
        ...(s.voice ? [[s.voice.el, voiceAudible] as const] : []),
      ] as const) {
        media.volume = vol;
        media.muted = !audible || vol <= 0.001 || !playing;
        media.preservesPitch = c.preservePitch;
        drive(media, desired, rate, playing, tolerance, media !== el);
      }
    }

    // Release elements nobody needs; keep a few idle ones briefly for back-and-forth scrubbing.
    const idle = [...this.slots.entries()].filter(([id]) => !active.has(id));
    idle.sort((a, b) => b[1].lastUsed - a[1].lastUsed);
    idle.forEach(([id, s], i) => {
      if (!s.el.paused) s.el.pause();
      s.voice?.el.pause();
      if (i >= MAX_IDLE_SLOTS || now - s.lastUsed > IDLE_RELEASE_MS || !p.clips.some((c) => c.id === id)) {
        this.dispose(s);
        this.slots.delete(id);
      }
    });
  }

  private draw(p: Project, t: number) {
    const ctx = this.ctx;
    const W = this.frameW;
    const H = this.frameH;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    for (const track of p.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      const c = p.clips.find((x) => x.trackId === track.id && x.start <= t && clipEnd(x) > t);
      if (!c) continue;
      const el = this.slots.get(c.id)?.el;
      if (!el || el.readyState < 2 || !el.videoWidth) continue;
      const boxW = W * c.scale;
      const boxH = H * c.scale;
      const fit = Math.min(boxW / el.videoWidth, boxH / el.videoHeight);
      const dw = el.videoWidth * fit;
      const dh = el.videoHeight * fit;
      const cx = W / 2 + c.x * W;
      const cy = H / 2 + c.y * H;
      ctx.globalAlpha = Math.max(0, Math.min(1, c.opacity));
      ctx.drawImage(el, cx - dw / 2, cy - dh / 2, dw, dh);
    }
    ctx.globalAlpha = 1;
  }
}

let current: PreviewEngine | null = null;
export const setEngine = (e: PreviewEngine | null) => (current = e);
export const engine = {
  toggle: () => current?.toggle(),
  play: () => current?.play(),
  pause: () => current?.pause(),
};
