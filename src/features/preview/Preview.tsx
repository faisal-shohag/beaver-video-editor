import { IconButton } from "@/components/editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { timecode } from "@/lib/time";
import { projectDuration } from "@/store/ops";
import { useProject } from "@/store/project";
import { useRuntime } from "@/store/runtime";
import { useUi } from "@/store/ui";
import {
  ChevronFirst,
  ChevronLast,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SquareArrowDownRight,
  SquareArrowUpLeft,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { PreviewEngine, engine, setEngine } from "./engine";
import { stepFrames } from "@/app/actions";

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const width = useProject((s) => s.project.width);
  const height = useProject((s) => s.project.height);
  const empty = useProject((s) => s.project.clips.length === 0);
  const engineRef = useRef<PreviewEngine | null>(null);

  const fit = () => {
    const area = areaRef.current;
    if (area) engineRef.current?.resize(area.clientWidth - 16, area.clientHeight - 16);
  };

  useEffect(() => {
    const e = new PreviewEngine(canvasRef.current!, hostRef.current!);
    engineRef.current = e;
    setEngine(e);
    const ro = new ResizeObserver(fit);
    ro.observe(areaRef.current!);
    return () => {
      ro.disconnect();
      e.destroy();
      engineRef.current = null;
      setEngine(null);
    };
  }, []);

  // Project aspect ratio changed: recompute the canvas box.
  useEffect(fit, [width, height]);

  return (
    <section className="flex h-full min-w-0 flex-col bg-panel" aria-label="Preview">
      <div ref={areaRef} className="relative flex min-h-0 flex-1 items-center justify-center p-3 pb-1">
        <canvas ref={canvasRef} className="rounded-xl bg-(--preview-bg) shadow-[0_0_0_1px_var(--border)]" />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <p className="text-sm">Drop videos or audio anywhere to start</p>
            <p className="text-xs text-faint">
              Dropped on the timeline, files are joined back to back · <Kbd>Ctrl</Kbd>+<Kbd>I</Kbd> to import
            </p>
          </div>
        )}
        {/* Hidden decoder elements live here. */}
        <div ref={hostRef} aria-hidden className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0" />
        <ProjectBadge />
      </div>
      <Transport />
    </section>
  );
}

function ProjectBadge() {
  const proxies = useRuntime((s) => Object.values(s.proxy).filter((p) => p === "pending").length);
  if (proxies === 0) return null;
  return (
    <div className="pointer-events-none absolute top-3 right-3">
      <Badge variant="secondary" className="text-warn">building {proxies} preview proxy…</Badge>
    </div>
  );
}

function Transport() {
  const playing = useUi((s) => s.playing);
  const shuttle = useUi((s) => s.shuttle);
  const inPoint = useUi((s) => s.inPoint);
  const outPoint = useUi((s) => s.outPoint);
  const set = useUi((s) => s.set);
  const seek = useUi((s) => s.seek);
  const project = useProject((s) => s.project);
  const duration = projectDuration(project);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 px-4">
      <Timecode duration={timecode(duration, project.fps)} />
      <div className="mx-auto flex items-center gap-0.5">
        <IconButton label="Mark in (I)" active={inPoint != null} onClick={() => set({ inPoint: useUi.getState().playhead })}>
          <SquareArrowDownRight size={16} />
        </IconButton>
        <IconButton label="Go to start (Home)" onClick={() => seek(0)}>
          <ChevronFirst size={17} />
        </IconButton>
        <IconButton label="Previous frame (←)" onClick={() => stepFrames(-1)}>
          <SkipBack size={15} />
        </IconButton>
        <Button
          variant="outline"
          size="icon-lg"
          aria-label={playing ? "Pause (Space)" : "Play (Space)"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          onClick={() => engine.toggle()}
          className="mx-1.5 size-9 rounded-full bg-card shadow-card transition-transform hover:scale-105"
        >
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
        </Button>
        <IconButton label="Next frame (→)" onClick={() => stepFrames(1)}>
          <SkipForward size={15} />
        </IconButton>
        <IconButton label="Go to end (End)" onClick={() => seek(duration)}>
          <ChevronLast size={17} />
        </IconButton>
        <IconButton label="Mark out (O)" active={outPoint != null} onClick={() => set({ outPoint: useUi.getState().playhead })}>
          <SquareArrowUpLeft size={16} />
        </IconButton>
      </div>
      <div className="flex w-[220px] items-center justify-end gap-2 font-mono text-xs text-muted-foreground">
        {shuttle > 1 && <Badge variant="secondary">{shuttle}×</Badge>}
        <span title="Project resolution and frame rate">
          {project.width}×{project.height} · {project.fps}fps
        </span>
      </div>
    </div>
  );
}

function Timecode({ duration }: { duration: string }) {
  const t = useUi((s) => s.playhead);
  const fps = useProject((s) => s.project.fps);
  return (
    <div
      className="flex h-9 w-[220px] items-center gap-2 rounded-[10px] border border-line px-3 font-mono text-xs tabular-nums"
      title="Playhead / timeline duration"
    >
      <span className="text-foreground">{timecode(t, fps)}</span>
      <span className="text-faint">/</span>
      <span className="text-muted-foreground">{duration}</span>
    </div>
  );
}
