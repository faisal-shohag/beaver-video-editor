import {
  deleteInOut,
  deleteSelection,
  detachAudio,
  setSpeed,
  splitAtPlayhead,
  splitClipAt,
  zoomBy,
  zoomToFit,
} from "@/app/actions";
import { IconButton, Kbd, Slider } from "@/components/ui";
import type { Track } from "@/lib/types";
import * as ops from "@/store/ops";
import { useProject } from "@/store/project";
import { ui, useUi } from "@/store/ui";
import clsx from "clsx";
import {
  Eye,
  EyeOff,
  Film,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  MousePointer2,
  Music,
  Plus,
  Scissors,
  ScissorsLineDashed,
  Trash2,
  Volume2,
  VolumeX,
  WrapText,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HEADER_W, RULER_H, computeLanes } from "./layout";
import { TimelineView, type ContextMenuRequest } from "./view";

let activeView: TimelineView | null = null;
/** Used by the media bin's pointer-drag to drop onto the timeline. */
export const timelineDrop = (ids: string[], x: number, y: number) => activeView?.dropMedia(ids, x, y) ?? false;
export const timelineViewportWidth = () => activeView?.viewportWidth ?? 800;

export function Timeline() {
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const lanesRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TimelineView | null>(null);
  const tracks = useProject((s) => s.project.tracks);
  const [menu, setMenu] = useState<ContextMenuRequest | null>(null);
  const layout = useMemo(() => computeLanes(tracks), [tracks]);

  useEffect(() => {
    const v = new TimelineView(rulerRef.current!, lanesRef.current!);
    v.onContextMenu = setMenu;
    viewRef.current = v;
    activeView = v;
    return () => {
      v.destroy();
      activeView = null;
    };
  }, []);

  useLayoutEffect(() => {
    const area = areaRef.current!;
    const fit = () => viewRef.current?.resize(area.clientWidth - HEADER_W, Math.max(layout.height, area.clientHeight - RULER_H - 13));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(area);
    return () => ro.disconnect();
  }, [layout.height]);

  const onWheel = (e: React.WheelEvent) => {
    const u = ui();
    const scroller = areaRef.current!.querySelector<HTMLElement>("[data-scroll]")!;
    const canScrollY = scroller.scrollHeight > scroller.clientHeight + 1;
    if (e.ctrlKey) {
      const rect = lanesRef.current!.getBoundingClientRect();
      const anchor = u.scrollX + (e.clientX - rect.left) / u.pxPerSec;
      zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, anchor);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !canScrollY) {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      u.set({ scrollX: Math.max(0, u.scrollX + delta / u.pxPerSec) });
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Timeline">
      <Toolbar />
      <div
        ref={areaRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-t border-line"
        onWheel={onWheel}
      >
        <div className="flex shrink-0" style={{ height: RULER_H }}>
          <div className="flex shrink-0 items-center gap-1 border-r border-b border-line px-2" style={{ width: HEADER_W }}>
            <AddTrackButton kind="video" />
            <AddTrackButton kind="audio" />
          </div>
          <canvas ref={rulerRef} className="block" />
        </div>
        <div data-scroll className="flex min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="relative shrink-0 border-r border-line bg-panel" style={{ width: HEADER_W, height: layout.height }}>
            {layout.lanes.map((l) => (
              <TrackHeader key={l.track.id} track={l.track} top={l.y} height={l.h} />
            ))}
          </div>
          <canvas ref={lanesRef} className="block" />
        </div>
        <HScrollbar />
      </div>
      {menu && <ClipMenu req={menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

function AddTrackButton({ kind }: { kind: "video" | "audio" }) {
  const edit = useProject((s) => s.edit);
  return (
    <button
      onClick={() => edit((d) => void ops.addTrack(d, kind))}
      title={`Add ${kind} track`}
      className="flex h-5 items-center gap-0.5 rounded px-1 text-[11px] text-muted hover:bg-panel-3 hover:text-fg"
    >
      <Plus size={11} />
      {kind === "video" ? <Film size={11} /> : <Music size={11} />}
    </button>
  );
}

function TrackHeader({ track, top, height }: { track: Track; top: number; height: number }) {
  const edit = useProject((s) => s.edit);
  const canRemove = useProject((s) => s.project.tracks.filter((t) => t.kind === track.kind).length > 1);
  const toggle = (key: "muted" | "hidden" | "locked") =>
    edit((d) => {
      const t = d.tracks.find((x) => x.id === track.id);
      if (t) t[key] = !t[key];
    });
  const isVideo = track.kind === "video";
  return (
    <div
      className="group absolute flex items-center gap-1 border-b border-line pr-1 pl-2"
      style={{ top, height, width: HEADER_W - 1 }}
    >
      <div
        className={clsx(
          "mr-auto flex h-6 min-w-8 items-center justify-center rounded px-1.5 text-[11px] font-semibold",
          isVideo ? "bg-video/20 text-[#9fb2ff]" : "bg-audio/20 text-[#7ee0bb]",
        )}
      >
        {track.name}
      </div>
      {isVideo && (
        <IconButton label={track.hidden ? "Show track" : "Hide track"} active={track.hidden} onClick={() => toggle("hidden")}>
          {track.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </IconButton>
      )}
      <IconButton label={track.muted ? "Unmute track" : "Mute track"} active={track.muted} onClick={() => toggle("muted")}>
        {track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </IconButton>
      <IconButton label={track.locked ? "Unlock track" : "Lock track"} active={track.locked} onClick={() => toggle("locked")}>
        {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
      </IconButton>
      {canRemove && (
        <button
          title="Remove track"
          aria-label="Remove track"
          onClick={() => edit((d) => ops.removeTrack(d, track.id))}
          className="absolute top-0.5 right-0.5 hidden h-3.5 w-3.5 items-center justify-center rounded text-faint group-hover:flex hover:bg-danger/20 hover:text-danger"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

function Toolbar() {
  const tool = useUi((s) => s.tool);
  const snap = useUi((s) => s.snap);
  const ripple = useUi((s) => s.ripple);
  const selection = useUi((s) => s.selection);
  const inPoint = useUi((s) => s.inPoint);
  const outPoint = useUi((s) => s.outPoint);
  const pxPerSec = useUi((s) => s.pxPerSec);
  const set = useUi((s) => s.set);
  const hasRange = inPoint != null && outPoint != null && outPoint > inPoint;
  const zoomLog = Math.log2(pxPerSec);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 px-2">
      <IconButton label="Select tool (V)" active={tool === "select"} onClick={() => set({ tool: "select" })}>
        <MousePointer2 size={15} />
      </IconButton>
      <IconButton label="Blade tool — click a clip to split (B)" active={tool === "blade"} onClick={() => set({ tool: "blade" })}>
        <ScissorsLineDashed size={15} />
      </IconButton>
      <div className="mx-1.5 h-5 w-px bg-line" />
      <IconButton label="Split at playhead (S)" onClick={() => splitAtPlayhead()}>
        <Scissors size={15} />
      </IconButton>
      <IconButton label="Delete selection (Del)" disabled={!selection.length && !hasRange} onClick={() => deleteSelection()}>
        <Trash2 size={15} />
      </IconButton>
      <button
        onClick={() => deleteInOut(true)}
        disabled={!hasRange}
        title="Cut out the In→Out range on all tracks and close the gap (Shift+Del)"
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-panel-3 hover:text-fg disabled:opacity-35"
      >
        <Scissors size={13} /> Cut range
      </button>
      <div className="mx-1.5 h-5 w-px bg-line" />
      <IconButton label="Snapping (N)" active={snap} onClick={() => set({ snap: !snap })}>
        <Magnet size={15} />
      </IconButton>
      <IconButton label="Ripple delete — close gaps when deleting" active={ripple} onClick={() => set({ ripple: !ripple })}>
        <WrapText size={15} />
      </IconButton>
      {(inPoint != null || outPoint != null) && (
        <div className="ml-2 flex items-center gap-1 rounded-md bg-accent/10 py-0.5 pr-0.5 pl-2 font-mono text-[11px] text-accent">
          In/Out set
          <IconButton label="Clear In/Out (Alt+X)" onClick={() => set({ inPoint: null, outPoint: null })} className="h-5 min-w-5">
            <X size={12} />
          </IconButton>
        </div>
      )}
      <div className="ml-auto flex items-center gap-2 text-muted">
        <span className="hidden text-[11px] text-faint xl:inline">
          <Kbd>Ctrl</Kbd>+wheel zoom · <Kbd>Shift</Kbd>+wheel scroll
        </span>
        <Slider
          label="Zoom"
          className="w-32"
          min={1}
          max={Math.log2(800)}
          step={0.01}
          value={zoomLog}
          onChange={(v) => zoomBy(2 ** v / pxPerSec)}
        />
        <IconButton label="Zoom to fit (\)" onClick={() => zoomToFit(timelineViewportWidth())}>
          <Maximize2 size={14} />
        </IconButton>
      </div>
    </div>
  );
}

function HScrollbar() {
  const scrollX = useUi((s) => s.scrollX);
  const pxPerSec = useUi((s) => s.pxPerSec);
  const duration = useProject((s) => ops.projectDuration(s.project));
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = trackRef.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const viewSecs = width / pxPerSec;
  const total = Math.max(duration + viewSecs * 0.5, viewSecs, scrollX + viewSecs, 1);
  const thumbW = Math.max(30, (viewSecs / total) * width);
  const thumbX = (scrollX / total) * width;

  const onDown = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const start = scrollX;
    const move = (ev: PointerEvent) =>
      ui().set({ scrollX: Math.max(0, start + ((ev.clientX - startX) / width) * total) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-3 shrink-0 border-t border-line bg-panel" style={{ paddingLeft: HEADER_W }}>
      <div ref={trackRef} className="relative flex-1">
        <div
          onPointerDown={onDown}
          className="absolute top-0.5 h-2 rounded-full bg-line-strong hover:bg-muted"
          style={{ left: thumbX, width: Math.min(thumbW, width) }}
        />
      </div>
    </div>
  );
}

function ClipMenu({ req, onClose }: { req: ContextMenuRequest; onClose: () => void }) {
  const project = useProject((s) => s.project);
  const edit = useProject((s) => s.edit);
  const clip = project.clips.find((c) => c.id === req.clipId);
  const media = clip && project.media.find((m) => m.id === clip.mediaId);
  const track = clip && project.tracks.find((t) => t.id === clip.trackId);
  const selection = useUi((s) => s.selection);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  const item = (label: string, action: () => void, opts: { disabled?: boolean; hint?: string; danger?: boolean } = {}) => (
    <button
      key={label}
      disabled={opts.disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        action();
        onClose();
      }}
      className={clsx(
        "flex w-full items-center justify-between gap-6 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-panel-3 disabled:opacity-35",
        opts.danger && "text-danger",
      )}
    >
      {label}
      {opts.hint && <span className="text-[11px] text-faint">{opts.hint}</span>}
    </button>
  );

  const x = Math.min(req.x, window.innerWidth - 230);
  const y = Math.min(req.y, window.innerHeight - 330);
  const ids = selection.length ? selection : clip ? [clip.id] : [];

  return (
    <div
      className="fixed z-50 w-56 rounded-lg border border-line bg-panel-2 p-1 shadow-2xl"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {clip ? (
        <>
          {item("Split here", () => splitClipAt(clip.id, req.time), { hint: "B" })}
          {item("Split at playhead", () => splitAtPlayhead(), { hint: "S" })}
          <div className="my-1 h-px bg-line" />
          <div className="px-2.5 pt-1 pb-0.5 text-[11px] text-faint">Speed</div>
          <div className="grid grid-cols-4 gap-1 px-1.5 pb-1">
            {[0.25, 0.5, 1, 1.5, 2, 4, 8, 16].map((s) => (
              <button
                key={s}
                onClick={() => {
                  setSpeed(ids, s);
                  onClose();
                }}
                className={clsx(
                  "rounded py-1 text-xs hover:bg-panel-3",
                  Math.abs(clip.speed - s) < 1e-6 ? "bg-accent/15 text-accent" : "text-fg/90",
                )}
              >
                {s}×
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-line" />
          {track?.kind === "video" &&
            media?.hasAudio &&
            item("Detach audio", () => detachAudio(clip.id), { disabled: clip.audioDetached })}
          {item("Reset transform", () =>
            edit((d) => ops.updateClips(d, ids, { x: 0, y: 0, scale: 1, opacity: 1 })),
          )}
          <div className="my-1 h-px bg-line" />
          {item("Delete", () => deleteSelection(false), { hint: "Del", danger: true })}
          {item("Ripple delete", () => deleteSelection(true), { hint: "Shift+Del", danger: true })}
        </>
      ) : (
        <>
          {item("Split all tracks at playhead", () => splitAtPlayhead(true), { hint: "Shift+S" })}
          {item("Set In here", () => ui().set({ inPoint: req.time }), { hint: "I" })}
          {item("Set Out here", () => ui().set({ outPoint: req.time }), { hint: "O" })}
        </>
      )}
    </div>
  );
}
