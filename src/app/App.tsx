import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ExportDialog } from "@/features/export/ExportDialog";
import { ExportQueue } from "@/features/export/ExportQueue";
import { listenToEnhance } from "@/features/enhance/enhance";
import { listenToJobs } from "@/features/export/jobs";
import { Inspector } from "@/features/inspector/Inspector";
import { QuickJoin } from "@/features/join/QuickJoin";
import { MediaBin } from "@/features/media-bin/MediaBin";
import { importPaths } from "@/features/media-bin/importer";
import { Preview } from "@/features/preview/Preview";
import { Timeline, timelineDrop } from "@/features/timeline/Timeline";
import { ipc } from "@/lib/ipc";
import { getProject, useProject } from "@/store/project";
import { useRuntime } from "@/store/runtime";
import { useUi } from "@/store/ui";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { FileDown, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast as sonner } from "sonner";
import { useDefaultLayout } from "react-resizable-panels";
import { restoreAutosave, serialize } from "./actions";
import { installShortcuts } from "./shortcuts";
import { TopBar } from "./TopBar";

const TIMELINE_KEY = "beaver.timelineHeight";

export function App() {
  const [timelineH, setTimelineH] = useState(() => {
    try {
      return Number(localStorage.getItem(TIMELINE_KEY)) || 330;
    } catch {
      return 330;
    }
  });
  const timelineRef = useRef<HTMLDivElement>(null);
  const [fileOver, setFileOver] = useState(false);
  const [autosave, setAutosave] = useState<string | null>(null);

  const panelLayout = useDefaultLayout({ id: "beaver.panels", storage: localStorage });

  useEffect(() => installShortcuts(), []);

  // One-time startup work.
  useEffect(() => {
    void listenToJobs();
    void listenToEnhance();
    useRuntime.setState({ benchmarking: true });
    ipc
      .getEncoders(false)
      .then((r) => useRuntime.setState({ encoders: r }))
      .catch((e) => console.warn("encoder benchmark failed", e))
      .finally(() => useRuntime.setState({ benchmarking: false }));
    ipc.readAutosave().then((text) => {
      if (!text) return;
      try {
        if (JSON.parse(text)?.project?.clips?.length) setAutosave(text);
      } catch {
        /* corrupt autosave: ignore */
      }
    });
  }, []);

  // Crash-safe autosave every 15 s while there are unsaved edits.
  useEffect(() => {
    const id = setInterval(() => {
      const { dirty, project } = useProject.getState();
      if (dirty && project.clips.length) void ipc.writeAutosave(serialize(project));
    }, 15000);
    return () => clearInterval(id);
  }, []);

  // Window title + unsaved-changes guard.
  useEffect(() => {
    const win = getCurrentWindow();
    const update = () => {
      const { project, dirty } = useProject.getState();
      void win.setTitle(`${dirty ? "• " : ""}${project.name || "Untitled"} — Beaver Video Editor`);
    };
    update();
    const unsub = useProject.subscribe((s, prev) => {
      if (s.dirty !== prev.dirty || s.project.name !== prev.project.name) update();
    });
    const off = win.onCloseRequested(async (e) => {
      const { dirty, project } = useProject.getState();
      if (!dirty || !project.clips.length) return;
      const quit = await ask("You have unsaved changes. Quit anyway?", { title: "Beaver Video Editor", kind: "warning" });
      if (!quit) e.preventDefault();
      else await ipc.clearAutosave();
    });
    return () => {
      unsub();
      void off.then((f) => f());
    };
  }, []);

  // Files dragged in from Explorer.
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") setFileOver(true);
      else if (p.type === "leave") setFileOver(false);
      else if (p.type === "drop") {
        setFileOver(false);
        const dpr = window.devicePixelRatio || 1;
        const x = p.position.x / dpr;
        const y = p.position.y / dpr;
        const rect = timelineRef.current?.getBoundingClientRect();
        const overTimeline = rect && y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right;
        const hadClips = getProject().clips.length > 0;
        // Empty timeline: everything is appended back to back (the joiner).
        const media = await importPaths(p.paths, { append: !hadClips });
        if (hadClips && overTimeline && media.length) timelineDrop(media.map((m) => m.id), x, y);
      }
    });
    return () => void off.then((f) => f());
  }, []);

  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = timelineH;
    const move = (ev: PointerEvent) => {
      const h = Math.min(window.innerHeight - 260, Math.max(180, startH - (ev.clientY - startY)));
      setTimelineH(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setTimelineH((h) => {
        try {
          localStorage.setItem(TIMELINE_KEY, String(h));
        } catch {
          /* storage unavailable */
        }
        return h;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <TooltipProvider delayDuration={400}>
    <div className="flex h-full flex-col px-3 pt-2 pb-3">
      <TopBar />
      {autosave && (
        <Alert className="mb-2 flex items-center gap-3 rounded-xl px-4 py-2 text-[13px] shadow-card">
          <History size={15} className="text-warn" />
          <span>Your previous session wasn't saved. Restore it?</span>
          <Button
            size="sm"
            onClick={() => {
              restoreAutosave(autosave);
              setAutosave(null);
            }}
          >
            Restore
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAutosave(null);
              void ipc.clearAutosave();
            }}
          >
            Discard
          </Button>
        </Alert>
      )}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={panelLayout.defaultLayout}
        onLayoutChanged={panelLayout.onLayoutChanged}
      >
        <ResizablePanel id="media" defaultSize="24.5%" minSize={200} maxSize="40%" groupResizeBehavior="preserve-pixel-size">
          <div className="h-full overflow-hidden rounded-2xl border border-border bg-card shadow-card">
            <MediaBin />
          </div>
        </ResizablePanel>
        <PanelGap />
        <ResizablePanel id="preview" minSize={360}>
          <div className="h-full overflow-hidden rounded-2xl border border-border bg-card shadow-card">
            <Preview />
          </div>
        </ResizablePanel>
        <PanelGap />
        <ResizablePanel id="inspector" defaultSize="27.5%" minSize={240} maxSize="40%" groupResizeBehavior="preserve-pixel-size">
          <div className="h-full overflow-hidden rounded-2xl border border-border bg-card shadow-card">
            <Inspector />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        onPointerDown={startResize}
        className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center"
      >
        <div className="h-1 w-12 rounded-full bg-transparent transition-colors group-hover:bg-line-strong" />
      </div>
      <div ref={timelineRef} className="shrink-0 overflow-hidden rounded-2xl border border-border bg-panel shadow-card" style={{ height: timelineH }}>
        <Timeline />
      </div>

      <Toaster position="bottom-center" />
      <ExportDialog />
      <QuickJoin />
      <ExportQueue />
      <Toast />
      <DragGhost />
      {fileOver && (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5">
          <div className="flex items-center gap-2 rounded-xl bg-panel px-4 py-2 text-sm shadow-pop">
            <FileDown size={16} className="text-primary" /> Drop to import — onto the timeline to place clips
          </div>
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}

/** The 12px gutter between cards doubles as the drag handle; a pill shows on hover/drag. */
function PanelGap() {
  return (
    <ResizableHandle className="w-3 bg-transparent before:absolute before:inset-y-1/3 before:left-1/2 before:w-1 before:-translate-x-1/2 before:rounded-full before:bg-transparent before:transition-colors after:w-3 hover:before:bg-border data-[separator=active]:before:bg-ring" />
  );
}

/** Bridges the `notify` store action to sonner toasts. */
function Toast() {
  const toast = useUi((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    if (toast.kind === "error") sonner.error(toast.text, { id: toast.id, duration: 6000, className: "whitespace-pre-line" });
    else sonner(toast.text, { id: toast.id, duration: 2500, className: "whitespace-pre-line" });
  }, [toast]);
  return null;
}

function DragGhost() {
  const drag = useUi((s) => s.dragMedia);
  const media = useProject((s) => s.project.media);
  if (!drag) return null;
  const first = media.find((m) => m.id === drag.ids[0]);
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-pop"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      {first?.name}
      {drag.ids.length > 1 && ` +${drag.ids.length - 1}`}
    </div>
  );
}
