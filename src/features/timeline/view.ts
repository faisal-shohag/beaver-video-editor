// Canvas timeline: rendering + pointer interaction. Redraws only when state changes.
import { splitClipAt } from "@/app/actions";
import { engine } from "@/features/preview/engine";
import { shortDuration, snapToFrame } from "@/lib/time";
import type { Clip, MediaItem } from "@/lib/types";
import * as ops from "@/store/ops";
import { getProject, useProject } from "@/store/project";
import { runtime, useRuntime } from "@/store/runtime";
import { ui, useUi } from "@/store/ui";
import { produce } from "immer";
import { EDGE_PX, RULER_H, computeLanes, laneAt, rulerStep, type Lane } from "./layout";

const WAVE_PPS = 50; // matches WAVEFORM_PEAKS_PER_SEC in Rust

const C = {
  bg: "#111317",
  laneA: "#15171c",
  laneB: "#13151a",
  line: "#23262e",
  ruler: "#15171c",
  rulerText: "#8b91a1",
  tick: "#3a3f4b",
  accent: "#f5a524",
  playhead: "#ffffff",
  video: "#2d3f9c",
  videoSel: "#3a52c4",
  audio: "#17684f",
  audioSel: "#1f8a69",
  wave: "rgba(190, 255, 225, 0.75)",
  waveOnVideo: "rgba(255, 255, 255, 0.45)",
  label: "#ffffff",
  danger: "#f0525a",
  range: "rgba(245, 165, 36, 0.10)",
  rangeRuler: "rgba(245, 165, 36, 0.35)",
};

type Drag =
  | { kind: "scrub" }
  | { kind: "pending"; ids: string[]; x0: number; y0: number; lane: Lane }
  | { kind: "move"; ids: string[]; x0: number; lane: Lane }
  | { kind: "trim"; id: string; side: "start" | "end" };

interface Hit {
  clip?: Clip;
  part?: "body" | "start" | "end";
  lane?: Lane;
}

export interface ContextMenuRequest {
  clipId: string | null;
  x: number;
  y: number;
  time: number;
}

export class TimelineView {
  private rctx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private width = 0;
  private laneHeight = 0;
  private dpr = 1;
  private dirty = true;
  private raf = 0;
  private drag: Drag | null = null;
  private hover: Hit = {};
  private hoverX: number | null = null;
  private snapLine: number | null = null;
  private overlapIds = new Set<string>();
  private unsubs: (() => void)[] = [];
  onContextMenu: ((r: ContextMenuRequest) => void) | null = null;

  constructor(
    private ruler: HTMLCanvasElement,
    private lanesCanvas: HTMLCanvasElement,
  ) {
    this.rctx = ruler.getContext("2d")!;
    this.lctx = lanesCanvas.getContext("2d")!;
    const mark = () => (this.dirty = true);
    this.unsubs.push(useProject.subscribe(mark), useUi.subscribe(mark), useRuntime.subscribe(mark));
    for (const el of [ruler, lanesCanvas]) {
      el.addEventListener("pointerdown", this.onDown);
      el.addEventListener("pointermove", this.onMove);
      el.addEventListener("pointerup", this.onUp);
      el.addEventListener("pointercancel", this.onUp);
      el.addEventListener("pointerleave", this.onLeave);
      el.addEventListener("contextmenu", this.onContext);
      el.addEventListener("dblclick", this.onDouble);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    for (const el of [this.ruler, this.lanesCanvas]) {
      el.removeEventListener("pointerdown", this.onDown);
      el.removeEventListener("pointermove", this.onMove);
      el.removeEventListener("pointerup", this.onUp);
      el.removeEventListener("pointercancel", this.onUp);
      el.removeEventListener("pointerleave", this.onLeave);
      el.removeEventListener("contextmenu", this.onContext);
      el.removeEventListener("dblclick", this.onDouble);
    }
  }

  resize(width: number, laneHeight: number) {
    this.dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.laneHeight = laneHeight;
    for (const [c, h] of [
      [this.ruler, RULER_H],
      [this.lanesCanvas, laneHeight],
    ] as const) {
      c.width = Math.round(width * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = `${width}px`;
      c.style.height = `${h}px`;
    }
    this.dirty = true;
  }

  get viewportWidth() {
    return this.width;
  }

  // ---------- coordinates ----------

  private timeAt(x: number) {
    const { scrollX, pxPerSec } = ui();
    return Math.max(0, scrollX + x / pxPerSec);
  }

  private xOf(t: number) {
    const { scrollX, pxPerSec } = ui();
    return (t - scrollX) * pxPerSec;
  }

  private local(e: PointerEvent | MouseEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private lanes() {
    return computeLanes(getProject().tracks).lanes;
  }

  private hitTest(x: number, y: number): Hit {
    const p = getProject();
    const lane = laneAt(this.lanes(), y);
    if (!lane) return {};
    const t = this.timeAt(x);
    const clips = p.clips.filter((c) => c.trackId === lane.track.id);
    // Prefer edges (they are thin targets), then bodies.
    for (const c of clips) {
      const x0 = this.xOf(c.start);
      const x1 = this.xOf(ops.clipEnd(c));
      const w = x1 - x0;
      const edge = Math.min(EDGE_PX, w / 3);
      if (x >= x0 - 2 && x <= x0 + edge) return { clip: c, part: "start", lane };
      if (x >= x1 - edge && x <= x1 + 2) return { clip: c, part: "end", lane };
    }
    const c = clips.find((c) => t >= c.start && t < ops.clipEnd(c));
    return c ? { clip: c, part: "body", lane } : { lane };
  }

  private snapThreshold() {
    return 8 / ui().pxPerSec;
  }

  private snapTargets(exclude: Set<string>) {
    const u = ui();
    const extra = [u.playhead];
    if (u.inPoint != null) extra.push(u.inPoint);
    if (u.outPoint != null) extra.push(u.outPoint);
    return ops.snapPoints(useProject.getState().gestureBase ?? getProject(), exclude, extra);
  }

  /** Time under the pointer snapped to edges/playhead (if snapping) and to frames. */
  snappedTime(x: number, exclude = new Set<string>()) {
    const p = getProject();
    let t = this.timeAt(x);
    this.snapLine = null;
    if (ui().snap) {
      const s = ops.nearestSnap(t, this.snapTargets(exclude), this.snapThreshold());
      if (s != null) {
        this.snapLine = s;
        return s;
      }
    }
    t = snapToFrame(t, p.fps);
    return t;
  }

  // ---------- pointer ----------

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const { x, y } = this.local(e, el);
    const u = ui();
    el.setPointerCapture(e.pointerId);
    if (el === this.ruler) {
      if (u.playing) engine.pause();
      this.drag = { kind: "scrub" };
      u.seek(this.snappedTime(x));
      return;
    }
    const hit = this.hitTest(x, y);
    const locked = hit.lane?.track.locked;
    if (hit.clip && u.tool === "blade" && !locked) {
      splitClipAt(hit.clip.id, this.snappedTime(x));
      return;
    }
    if (hit.clip && !locked && (hit.part === "start" || hit.part === "end")) {
      if (!u.selection.includes(hit.clip.id)) u.select([hit.clip.id]);
      useProject.getState().beginGesture();
      this.drag = { kind: "trim", id: hit.clip.id, side: hit.part };
      return;
    }
    if (hit.clip) {
      const id = hit.clip.id;
      let sel = u.selection;
      if (e.ctrlKey || e.shiftKey || e.metaKey) {
        sel = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
      } else if (!sel.includes(id)) {
        sel = [id];
      }
      u.select(sel);
      if (sel.includes(id) && !locked) {
        const p = getProject();
        const movable = sel.filter((s) => {
          const c = p.clips.find((c) => c.id === s);
          return c && !ops.trackOf(p, c.trackId)?.locked;
        });
        this.drag = { kind: "pending", ids: movable, x0: x, y0: y, lane: hit.lane! };
      }
      return;
    }
    // Empty area: deselect and scrub.
    u.select([]);
    if (u.playing) engine.pause();
    this.drag = { kind: "scrub" };
    u.seek(this.snappedTime(x));
  };

  private onMove = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const { x, y } = this.local(e, el);
    const d = this.drag;
    if (!d) {
      this.hoverX = x;
      this.hover = el === this.lanesCanvas ? this.hitTest(x, y) : {};
      const u = ui();
      let cursor = "default";
      if (el === this.ruler) cursor = "text";
      else if (u.tool === "blade") cursor = this.hover.clip ? "crosshair" : "default";
      else if (this.hover.part === "start" || this.hover.part === "end") cursor = "ew-resize";
      else if (this.hover.clip) cursor = "grab";
      el.style.cursor = this.hover.lane?.track.locked ? "not-allowed" : cursor;
      this.dirty = true;
      return;
    }
    if (d.kind === "scrub") {
      ui().seek(this.snappedTime(x));
    } else if (d.kind === "trim") {
      const t = this.snappedTime(x, new Set([d.id]));
      useProject.getState().updateGesture((p) => {
        if (d.side === "start") ops.trimStart(p, d.id, t);
        else ops.trimEnd(p, d.id, t);
      });
    } else if (d.kind === "pending") {
      if (Math.abs(x - d.x0) > 3 || Math.abs(y - d.y0) > 6) {
        useProject.getState().beginGesture();
        this.drag = { kind: "move", ids: d.ids, x0: d.x0, lane: d.lane };
        this.lanesCanvas.style.cursor = "grabbing";
        this.onMove(e);
      }
    } else if (d.kind === "move") {
      const base = useProject.getState().gestureBase!;
      const { pxPerSec } = ui();
      let dt = (x - d.x0) / pxPerSec;
      const moving = base.clips.filter((c) => d.ids.includes(c.id));
      this.snapLine = null;
      let best: number | null = null;
      if (ui().snap && moving.length) {
        const targets = this.snapTargets(new Set(d.ids));
        let bestDist = this.snapThreshold();
        for (const c of moving) {
          for (const edge of [c.start + dt, ops.clipEnd(c) + dt]) {
            const s = ops.nearestSnap(edge, targets, bestDist);
            if (s != null && Math.abs(s - edge) <= bestDist) {
              bestDist = Math.abs(s - edge);
              best = s - edge;
              this.snapLine = s;
            }
          }
        }
      }
      // Stick to the snapped edge exactly; otherwise keep clip starts frame-aligned.
      dt = best != null ? dt + best : frameAlignedDelta(moving, dt, base.fps);
      const target = laneAt(this.lanes(), y);
      const laneDelta = target && target.track.kind === d.lane.track.kind ? target.kindIndex - d.lane.kindIndex : 0;
      useProject.getState().updateGesture((p) => ops.moveClips(p, d.ids, dt, laneDelta));
      const after = getProject();
      this.overlapIds = new Set(ops.hasOverlap(after, d.ids) ? d.ids : []);
    }
    this.dirty = true;
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    this.snapLine = null;
    this.overlapIds.clear();
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!d) return;
    const store = useProject.getState();
    if (d.kind === "trim") store.endGesture(true);
    if (d.kind === "move") {
      let ok = true;
      const resolved = produce(getProject(), (p) => {
        ok = ops.resolveDrop(p, d.ids);
      });
      if (ok) {
        useProject.setState({ project: resolved });
        store.endGesture(true);
      } else {
        store.endGesture(false);
        ui().notify("Clips would overlap — move cancelled", "error");
      }
    }
    this.dirty = true;
  };

  private onLeave = () => {
    this.hoverX = null;
    this.hover = {};
    this.dirty = true;
  };

  private onContext = (e: MouseEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const { x, y } = this.local(e, el);
    const hit = el === this.lanesCanvas ? this.hitTest(x, y) : {};
    if (hit.clip && !ui().selection.includes(hit.clip.id)) ui().select([hit.clip.id]);
    this.onContextMenu?.({ clipId: hit.clip?.id ?? null, x: e.clientX, y: e.clientY, time: this.timeAt(x) });
  };

  private onDouble = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const { x, y } = this.local(e, el);
    const hit = el === this.lanesCanvas ? this.hitTest(x, y) : {};
    if (hit.clip) ui().seek(hit.clip.start);
  };

  /** Drop media dragged from the bin at client coordinates. Returns true if handled. */
  dropMedia(ids: string[], clientX: number, clientY: number): boolean {
    const r = this.lanesCanvas.getBoundingClientRect();
    const rr = this.ruler.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < rr.top || clientY > r.bottom) return false;
    const x = clientX - r.left;
    const lane = laneAt(this.lanes(), clientY - r.top);
    let t = this.snappedTime(x);
    this.snapLine = null;
    const p = getProject();
    const media = ids.map((id) => p.media.find((m) => m.id === id)).filter((m): m is MediaItem => !!m);
    useProject.getState().edit((d) => {
      const created: string[] = [];
      for (const m of media) {
        const [id] = ops.insertMedia(d, m, lane?.track.id ?? null, t);
        const c = d.clips.find((c) => c.id === id)!;
        t = ops.clipEnd(c);
        created.push(id);
      }
      ui().select(created);
    });
    return true;
  }

  // ---------- rendering ----------

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const u = ui();
    if (u.playing && this.width > 0) {
      // Page-follow the playhead during playback.
      const x = this.xOf(u.playhead);
      if (x > this.width - 30 || x < 0) u.set({ scrollX: Math.max(0, u.playhead - 30 / u.pxPerSec) });
    }
    if (!this.dirty || this.width === 0) return;
    this.dirty = false;
    this.drawRuler();
    this.drawLanes();
  };

  private drawRuler() {
    const ctx = this.rctx;
    const p = getProject();
    const u = ui();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, this.width, RULER_H);
    if (u.inPoint != null || u.outPoint != null) {
      const a = this.xOf(u.inPoint ?? 0);
      const b = this.xOf(u.outPoint ?? ops.projectDuration(p));
      ctx.fillStyle = C.rangeRuler;
      ctx.fillRect(a, RULER_H - 6, b - a, 6);
    }
    const { major, minor } = rulerStep(u.pxPerSec, p.fps);
    const t0 = u.scrollX;
    const t1 = t0 + this.width / u.pxPerSec;
    ctx.strokeStyle = C.tick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(this.xOf(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 12 : 20);
      ctx.lineTo(x, RULER_H);
    }
    ctx.stroke();
    ctx.fillStyle = C.rulerText;
    ctx.font = "10px 'Cascadia Mono', Consolas, monospace";
    ctx.textBaseline = "top";
    for (let t = Math.floor(t0 / major) * major; t <= t1; t += major) {
      const x = this.xOf(t);
      const label = major < 1 ? shortDuration(t, true) : shortDuration(t);
      ctx.fillText(label, x + 4, 3);
    }
    ctx.fillStyle = C.line;
    ctx.fillRect(0, RULER_H - 1, this.width, 1);
    // Playhead head
    const px = this.xOf(u.playhead);
    if (px >= -8 && px <= this.width + 8) {
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.moveTo(px - 6, RULER_H - 12);
      ctx.lineTo(px + 6, RULER_H - 12);
      ctx.lineTo(px + 6, RULER_H - 6);
      ctx.lineTo(px, RULER_H);
      ctx.lineTo(px - 6, RULER_H - 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawLanes() {
    const ctx = this.lctx;
    const p = getProject();
    const u = ui();
    const rt = runtime();
    const { lanes, dividerY } = computeLanes(p.tracks);
    const W = this.width;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, this.laneHeight);

    lanes.forEach((lane, i) => {
      ctx.fillStyle = i % 2 ? C.laneB : C.laneA;
      ctx.fillRect(0, lane.y, W, lane.h);
      ctx.fillStyle = C.line;
      ctx.fillRect(0, lane.y + lane.h - 1, W, 1);
    });
    ctx.fillStyle = "#0b0c0f";
    ctx.fillRect(0, dividerY, W, 8);

    // In/Out range tint
    if (u.inPoint != null || u.outPoint != null) {
      const a = this.xOf(u.inPoint ?? 0);
      const b = this.xOf(u.outPoint ?? ops.projectDuration(p));
      ctx.fillStyle = C.range;
      ctx.fillRect(a, 0, b - a, this.laneHeight);
    }

    const t0 = u.scrollX;
    const t1 = t0 + W / u.pxPerSec;
    const media = new Map(p.media.map((m) => [m.id, m]));
    const sel = new Set(u.selection);
    for (const lane of lanes) {
      for (const c of p.clips) {
        if (c.trackId !== lane.track.id) continue;
        if (ops.clipEnd(c) < t0 || c.start > t1) continue;
        this.drawClip(ctx, c, lane, media.get(c.mediaId), sel.has(c.id), rt);
      }
      if (lane.track.locked) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(0, lane.y, W, lane.h - 1);
      }
    }

    // Bin drag ghost
    const drag = u.dragMedia;
    if (drag) {
      const r = this.lanesCanvas.getBoundingClientRect();
      const x = drag.x - r.left;
      const y = drag.y - r.top;
      if (x >= 0 && x <= W && y >= -RULER_H && y <= r.height) {
        const lane = laneAt(lanes, y);
        const first = p.media.find((m) => m.id === drag.ids[0]);
        const total = drag.ids.reduce((s, id) => s + (media.get(id)?.duration ?? 0), 0);
        const kind = first?.hasVideo ? "video" : "audio";
        const target = lane && lane.track.kind === kind ? lane : lanes.find((l) => l.track.kind === kind);
        if (target) {
          const gx = this.xOf(this.snappedTime(x));
          ctx.fillStyle = "rgba(245,165,36,0.18)";
          ctx.strokeStyle = C.accent;
          ctx.lineWidth = 1.5;
          roundRect(ctx, gx, target.y + 3, total * u.pxPerSec, target.h - 7, 6);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // Snap guide
    if (this.snapLine != null) {
      const x = Math.round(this.xOf(this.snapLine)) + 0.5;
      ctx.strokeStyle = C.accent;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.laneHeight);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Blade preview
    if (u.tool === "blade" && this.hoverX != null && this.hover.clip && !this.drag) {
      const x = Math.round(this.hoverX) + 0.5;
      const lane = this.hover.lane!;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, lane.y + 2);
      ctx.lineTo(x, lane.y + lane.h - 3);
      ctx.stroke();
    }

    // Playhead line
    const px = Math.round(this.xOf(u.playhead)) + 0.5;
    if (px >= 0 && px <= W) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.laneHeight);
      ctx.stroke();
    }
  }

  private drawClip(
    ctx: CanvasRenderingContext2D,
    c: Clip,
    lane: Lane,
    m: MediaItem | undefined,
    selected: boolean,
    rt: ReturnType<typeof runtime>,
  ) {
    const { pxPerSec } = ui();
    const x = this.xOf(c.start);
    const w = Math.max(2, ops.clipDuration(c) * pxPerSec);
    const y = lane.y + 3;
    const h = lane.h - 7;
    const isVideo = lane.track.kind === "video";
    const hovered = this.hover.clip?.id === c.id && !this.drag;
    const dim = (isVideo && lane.track.hidden) || (!isVideo && lane.track.muted);

    ctx.save();
    if (dim) ctx.globalAlpha = 0.45;
    roundRect(ctx, x, y, w, h, 5);
    ctx.fillStyle = isVideo ? (selected ? C.videoSel : C.video) : selected ? C.audioSel : C.audio;
    ctx.fill();
    ctx.clip();

    const labelH = isVideo ? 16 : 15;
    // Filmstrip
    const th = m && rt.thumbs[m.id];
    if (isVideo && th && m) {
      const bodyY = y + labelH;
      const bodyH = h - labelH;
      const tileW = (bodyH * th.meta.tileWidth) / th.meta.tileHeight;
      const vx0 = Math.max(x, 0);
      const vx1 = Math.min(x + w, this.width);
      const first = Math.floor((vx0 - x) / tileW);
      for (let i = first; x + i * tileW < vx1; i++) {
        const tx = x + i * tileW;
        const tt = c.start + (i * tileW + tileW / 2) / pxPerSec;
        const src = c.in + (tt - c.start) * c.speed;
        const idx = Math.min(th.meta.count - 1, Math.max(0, Math.floor((src / m.duration) * th.meta.count)));
        ctx.drawImage(
          th.img,
          idx * th.meta.tileWidth,
          0,
          th.meta.tileWidth,
          th.meta.tileHeight,
          tx,
          bodyY,
          tileW,
          bodyH,
        );
      }
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(x, bodyY, w, bodyH);
    }

    // Waveform
    const wave = m && rt.waveforms[m.id];
    const audible = m?.hasAudio && !(isVideo && c.audioDetached);
    if (wave && audible) {
      const waveH = isVideo ? 14 : h - labelH - 3;
      const base = y + h - 2;
      ctx.fillStyle = isVideo ? C.waveOnVideo : C.wave;
      const vx0 = Math.max(Math.floor(x), 0);
      const vx1 = Math.min(Math.ceil(x + w), this.width);
      const gain = Math.min(1.6, Math.max(0.2, c.volume));
      ctx.beginPath();
      for (let px = vx0; px < vx1; px++) {
        const s0 = c.in + ((px - x) / pxPerSec) * c.speed;
        const s1 = c.in + ((px + 1 - x) / pxPerSec) * c.speed;
        const i0 = Math.max(0, Math.floor(s0 * WAVE_PPS));
        const i1 = Math.min(wave.length, Math.max(i0 + 1, Math.ceil(s1 * WAVE_PPS)));
        let peak = 0;
        for (let i = i0; i < i1; i++) if (wave[i] > peak) peak = wave[i];
        const ph = Math.min(waveH, (peak / 255) * waveH * gain);
        if (isVideo) ctx.rect(px, base - ph, 1, ph);
        else ctx.rect(px, base - waveH / 2 - ph / 2, 1, Math.max(1, ph));
      }
      ctx.fill();
    }

    // Label strip
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(x, y, w, labelH);
    if (w > 28) {
      ctx.fillStyle = C.label;
      ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
      ctx.textBaseline = "middle";
      let tx = Math.max(x, 0) + 6;
      if (Math.abs(c.speed - 1) > 1e-6) {
        const badge = `${fmtSpeed(c.speed)}×`;
        const bw = ctx.measureText(badge).width + 8;
        ctx.fillStyle = C.accent;
        roundRect(ctx, tx - 2, y + 2, bw, labelH - 4, 3);
        ctx.fill();
        ctx.fillStyle = "#1c1303";
        ctx.fillText(badge, tx + 2, y + labelH / 2 + 0.5);
        tx += bw + 4;
        ctx.fillStyle = C.label;
      }
      const name = (m?.name ?? "Missing media") + (c.audioDetached && isVideo ? "  (audio detached)" : "");
      const maxW = x + w - tx - 6;
      if (maxW > 10) ctx.fillText(ellipsize(ctx, name, maxW), tx, y + labelH / 2 + 0.5);
    }
    ctx.restore();

    // Border
    const overlapping = this.overlapIds.has(c.id);
    if (selected || hovered || overlapping) {
      ctx.save();
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 5);
      ctx.strokeStyle = overlapping ? C.danger : selected ? C.accent : "rgba(255,255,255,0.5)";
      ctx.lineWidth = selected || overlapping ? 2 : 1;
      ctx.stroke();
      ctx.restore();
    }
    // Trim handles
    if ((hovered || selected) && ui().tool === "select" && w > 16 && !lane.track.locked) {
      ctx.fillStyle = hovered && this.hover.part === "start" ? C.accent : "rgba(255,255,255,0.7)";
      roundRect(ctx, x + 2, y + h / 2 - 9, 3, 18, 1.5);
      ctx.fill();
      ctx.fillStyle = hovered && this.hover.part === "end" ? C.accent : "rgba(255,255,255,0.7)";
      roundRect(ctx, x + w - 5, y + h / 2 - 9, 3, 18, 1.5);
      ctx.fill();
    }
  }

  invalidate() {
    this.dirty = true;
  }
}

/** Frame-align a move so clip starts land on frame boundaries. */
function frameAlignedDelta(moving: Clip[], dt: number, fps: number): number {
  if (!moving.length) return dt;
  const first = moving.reduce((a, b) => (a.start < b.start ? a : b));
  const target = snapToFrame(first.start + dt, fps);
  return target - first.start;
}

function fmtSpeed(s: number) {
  return s >= 10 ? s.toFixed(0) : s.toFixed(s % 1 === 0 ? 0 : 2).replace(/0$/, "");
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rr);
}
