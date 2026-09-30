import { Button, IconButton } from "@/components/ui";
import { ipc } from "@/lib/ipc";
import { useProject } from "@/store/project";
import { useRuntime } from "@/store/runtime";
import { useUi } from "@/store/ui";
import { FilePlus, FolderOpen, Gauge, Loader2, Merge, Redo2, Save, Undo2, Upload, Zap } from "lucide-react";
import { importDialog, newProject, openProject, redo, saveProject, undo } from "./actions";
import { CODEC_LABEL } from "@/features/export/presets";

export function TopBar() {
  const name = useProject((s) => s.project.name);
  const dirty = useProject((s) => s.dirty);
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);
  const hasClips = useProject((s) => s.project.clips.length > 0);
  const set = useUi((s) => s.set);

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      <div className="mr-2 flex items-center gap-2 pl-1">
        <img src="/beaver.svg" alt="" className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-tight">Beaver</span>
      </div>
      <IconButton label="New project (Ctrl+N)" onClick={() => newProject()}>
        <FilePlus size={16} />
      </IconButton>
      <IconButton label="Open project (Ctrl+O)" onClick={() => openProject()}>
        <FolderOpen size={16} />
      </IconButton>
      <IconButton label="Save project (Ctrl+S)" onClick={() => saveProject(false)}>
        <Save size={16} />
      </IconButton>
      <div className="mx-1.5 h-5 w-px bg-line" />
      <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <Redo2 size={16} />
      </IconButton>
      <div className="mx-1.5 h-5 w-px bg-line" />
      <Button variant="ghost" size="sm" onClick={() => importDialog(false)} title="Import media (Ctrl+I)">
        <Upload size={14} /> Import
      </Button>
      <Button variant="ghost" size="sm" onClick={() => set({ joinOpen: true })} title="Join same-format files losslessly (Ctrl+J)">
        <Merge size={14} /> Quick Join
      </Button>

      <div className="mx-auto flex min-w-0 items-center gap-1.5 text-[13px]">
        <span className="truncate text-fg/90">{name || "Untitled"}</span>
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Unsaved changes" />}
      </div>

      <EncoderChip />
      <Button variant="primary" onClick={() => set({ exportOpen: true })} disabled={!hasClips} title="Export (Ctrl+E)" className="ml-2 px-4">
        <Zap size={14} fill="currentColor" /> Export
      </Button>
    </header>
  );
}

function EncoderChip() {
  const report = useRuntime((s) => s.encoders);
  const busy = useRuntime((s) => s.benchmarking);
  const rerun = async () => {
    useRuntime.setState({ benchmarking: true });
    try {
      useRuntime.setState({ encoders: await ipc.getEncoders(true) });
    } finally {
      useRuntime.setState({ benchmarking: false });
    }
  };
  if (busy) {
    return (
      <span className="flex items-center gap-1.5 rounded-md bg-panel-3 px-2 py-1 text-[11px] text-muted" title="Measuring which encoders are fastest on this PC (runs once)">
        <Loader2 size={12} className="spin" /> Tuning encoders…
      </span>
    );
  }
  if (!report) return null;
  const summary = Object.entries(report.best)
    .map(([codec, enc]) => `${CODEC_LABEL[codec as keyof typeof CODEC_LABEL]}: ${enc}`)
    .join("\n");
  const hw = report.results.filter((r) => r.ok && r.hardware).map((r) => r.encoder);
  return (
    <button
      onClick={rerun}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-panel-3 hover:text-fg"
      title={`Fastest encoders on this PC:\n${summary}\n\n${report.ffmpegVersion}\nClick to re-run the benchmark.`}
    >
      <Gauge size={13} className={hw.length ? "text-ok" : "text-muted"} />
      {hw.length ? `GPU: ${hw.map((h) => h.split("_")[1]).filter((v, i, a) => a.indexOf(v) === i).join(", ").toUpperCase()}` : "CPU encoding"}
    </button>
  );
}
