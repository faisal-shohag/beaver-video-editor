import { Button } from "@/components/ui";
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
import { ui, useUi } from "@/store/ui";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { FileDown, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
    <div className="flex h-full flex-col">
      <TopBar />
      {autosave && (
        <div className="flex items-center gap-3 border-b border-accent/30 bg-accent/10 px-4 py-2 text-[13px]">
          <History size={15} className="text-accent" />
          <span>Your previous session wasn't saved. Restore it?</span>
          <Button
            size="sm"
            variant="primary"
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
        </div>
      )}
      <main className="flex min-h-0 flex-1">
        <div className="w-[260px] shrink-0 border-r border-line">
          <MediaBin />
        </div>
        <div className="min-w-0 flex-1">
          <Preview />
        </div>
        <div className="w-[300px] shrink-0 border-l border-line">
          <Inspector />
        </div>
      </main>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        onPointerDown={startResize}
        className="h-1 shrink-0 cursor-row-resize bg-line transition-colors hover:bg-accent/60"
      />
      <div ref={timelineRef} className="shrink-0" style={{ height: timelineH }}>
        <Timeline />
      </div>

      <ExportDialog />
      <QuickJoin />
      <ExportQueue />
      <Toast />
      <DragGhost />
      {fileOver && (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/5">
          <div className="flex items-center gap-2 rounded-lg bg-panel-2 px-4 py-2 text-sm shadow-xl">
            <FileDown size={16} className="text-accent" /> Drop to import — onto the timeline to place clips
          </div>
        </div>
      )}
    </div>
  );
}

function Toast() {
  const toast = useUi((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => ui().set({ toast: null }), toast.kind === "error" ? 6000 : 2500);
    return () => clearTimeout(id);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      key={toast.id}
      role="status"
      className={clsx(
        "toast-in fixed bottom-4 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded-lg border px-4 py-2 text-[13px] whitespace-pre-line shadow-xl",
        toast.kind === "error" ? "border-danger/40 bg-[#2a1416] text-[#ffb4b8]" : "border-line bg-panel-2 text-fg",
      )}
    >
      {toast.text}
    </div>
  );
}

function DragGhost() {
  const drag = useUi((s) => s.dragMedia);
  const media = useProject((s) => s.project.media);
  if (!drag) return null;
  const first = media.find((m) => m.id === drag.ids[0]);
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg shadow-lg"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      {first?.name}
      {drag.ids.length > 1 && ` +${drag.ids.length - 1}`}
    </div>
  );
}
