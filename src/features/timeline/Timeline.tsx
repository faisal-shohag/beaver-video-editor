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
import { IconButton, Slider } from "@/components/editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
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
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        onWheel={onWheel}
      >
        <div className="flex shrink-0" style={{ height: RULER_H }}>
          <div className="flex shrink-0 items-center gap-1 px-2" style={{ width: HEADER_W }}>
            <AddTrackButton kind="video" />
            <AddTrackButton kind="audio" />
          </div>
          <canvas ref={rulerRef} className="block" />
        </div>
        <div data-scroll className="flex min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="relative shrink-0 bg-panel" style={{ width: HEADER_W, height: layout.height }}>
            {layout.lanes.map((l) => (
              <TrackHeader key={l.track.id} track={l.track} top={l.y} height={l.h} />
            ))}
          </div>
          <canvas ref={lanesRef} className="block" />
        </div>
        <HScrollbar />
      </div>
      {menu && <ClipMenu key={`${menu.x}:${menu.y}`} req={menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

function AddTrackButton({ kind }: { kind: "video" | "audio" }) {
  const edit = useProject((s) => s.edit);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => edit((d) => void ops.addTrack(d, kind))}
      title={`Add ${kind} track`}
      className="h-6 gap-0.5 px-1.5 text-[11px] text-muted-foreground"
    >
      <Plus size={11} />
      {kind === "video" ? <Film size={11} /> : <Music size={11} />}
    </Button>
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
      className="group absolute flex items-center gap-0.5 pr-1 pl-2"
      style={{ top, height, width: HEADER_W - 1 }}
    >
      <Badge variant="secondary" className="mr-auto h-6 min-w-9 justify-center gap-1.5 rounded-lg px-2 font-mono text-[11px] font-semibold">
        <span className={clsx("size-1.5 rounded-full", isVideo ? "bg-video" : "bg-audio")} />
        {track.name}
      </Badge>
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
        <Button
          variant="ghost"
          size="icon-xs"
          title="Remove track"
          aria-label="Remove track"
          onClick={() => edit((d) => ops.removeTrack(d, track.id))}
          className="absolute top-0.5 right-0.5 hidden size-4 rounded text-faint group-hover:flex hover:text-destructive"
        >
          <X size={10} />
        </Button>
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
    <div className="flex h-12 shrink-0 items-center gap-1 border-b bg-toolbar px-3">
      <IconButton label="Select tool (V)" active={tool === "select"} onClick={() => set({ tool: "select" })}>
        <MousePointer2 size={15} />
      </IconButton>
      <IconButton label="Blade tool — click a clip to split (B)" active={tool === "blade"} onClick={() => set({ tool: "blade" })}>
        <ScissorsLineDashed size={15} />
      </IconButton>
      <Separator orientation="vertical" className="mx-1.5 h-5" />
      <IconButton label="Split at playhead (S)" onClick={() => splitAtPlayhead()}>
        <Scissors size={15} />
      </IconButton>
      <IconButton label="Delete selection (Del)" disabled={!selection.length && !hasRange} onClick={() => deleteSelection()}>
        <Trash2 size={15} />
      </IconButton>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => deleteInOut(true)}
        disabled={!hasRange}
        title="Cut out the In→Out range on all tracks and close the gap (Shift+Del)"
        className="h-8 rounded-[10px] text-xs text-muted-foreground"
      >
        <Scissors size={13} /> Cut range
      </Button>
      <Separator orientation="vertical" className="mx-1.5 h-5" />
      <IconButton label="Snapping (N)" active={snap} onClick={() => set({ snap: !snap })}>
        <Magnet size={15} />
      </IconButton>
      <IconButton label="Ripple delete — close gaps when deleting" active={ripple} onClick={() => set({ ripple: !ripple })}>
        <WrapText size={15} />
      </IconButton>
      {(inPoint != null || outPoint != null) && (
        <Badge variant="secondary" className="ml-2 h-7 gap-1 pr-0.5 pl-2 font-mono text-[11px] text-warn">
          In/Out set
          <IconButton label="Clear In/Out (Alt+X)" onClick={() => set({ inPoint: null, outPoint: null })} className="size-5 min-w-5">
            <X size={12} />
          </IconButton>
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-2 text-muted-foreground">
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
    <div className="flex h-3 shrink-0 bg-panel" style={{ paddingLeft: HEADER_W }}>
      <div ref={trackRef} className="relative flex-1">
        <div
          onPointerDown={onDown}
          className="absolute top-0.5 h-2 rounded-full bg-line-strong hover:bg-muted-foreground"
          style={{ left: thumbX, width: Math.min(thumbW, width) }}
        />
      </div>
    </div>
  );
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8, 16];

/** Clip/empty-area context menu, anchored at the pointer position the canvas reported. */
function ClipMenu({ req, onClose }: { req: ContextMenuRequest; onClose: () => void }) {
  const project = useProject((s) => s.project);
  const edit = useProject((s) => s.edit);
  const clip = project.clips.find((c) => c.id === req.clipId);
  const media = clip && project.media.find((m) => m.id === clip.mediaId);
  const track = clip && project.tracks.find((t) => t.id === clip.trackId);
  const selection = useUi((s) => s.selection);
  const ids = selection.length ? selection : clip ? [clip.id] : [];
  const currentSpeed = clip ? SPEEDS.find((s) => Math.abs(clip.speed - s) < 1e-6) : undefined;

  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: req.x, top: req.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={0}
        className="w-56"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {clip ? (
          <>
            <DropdownMenuItem onSelect={() => splitClipAt(clip.id, req.time)}>
              Split here <DropdownMenuShortcut>B</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => splitAtPlayhead()}>
              Split at playhead <DropdownMenuShortcut>S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Speed</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={currentSpeed === undefined ? "" : String(currentSpeed)}
                  onValueChange={(v) => setSpeed(ids, Number(v))}
                >
                  {SPEEDS.map((s) => (
                    <DropdownMenuRadioItem key={s} value={String(s)}>
                      {s}×
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            {track?.kind === "video" && media?.hasAudio && (
              <DropdownMenuItem disabled={clip.audioDetached} onSelect={() => detachAudio(clip.id)}>
                Detach audio
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => edit((d) => ops.updateClips(d, ids, { x: 0, y: 0, scale: 1, opacity: 1 }))}>
              Reset transform
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => deleteSelection(false)}>
              Delete <DropdownMenuShortcut>Del</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => deleteSelection(true)}>
              Ripple delete <DropdownMenuShortcut>Shift+Del</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuLabel className="sr-only">Timeline</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => splitAtPlayhead(true)}>
              Split all tracks at playhead <DropdownMenuShortcut>Shift+S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ui().set({ inPoint: req.time })}>
              Set In here <DropdownMenuShortcut>I</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ui().set({ outPoint: req.time })}>
              Set Out here <DropdownMenuShortcut>O</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
