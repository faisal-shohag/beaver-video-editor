import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/editor";
import { ipc } from "@/lib/ipc";
import { useProject } from "@/store/project";
import { useRuntime } from "@/store/runtime";
import { nextThemePref, useTheme, type ThemePref } from "@/lib/theme";
import { useUi } from "@/store/ui";
import { useRef, useState } from "react";
import { FilePlus, FolderOpen, Gauge, Merge, Monitor, Moon, Redo2, Save, Sun, Undo2, Upload, Zap } from "lucide-react";
import { importDialog, newProject, openProject, redo, saveProject, undo } from "./actions";
import { CODEC_LABEL } from "@/features/export/presets";

export function TopBar() {
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);
  const hasClips = useProject((s) => s.project.clips.length > 0);
  const set = useUi((s) => s.set);

  return (
    <header className="mb-2 flex h-11 shrink-0 items-center gap-1">
      <div className="mr-2 flex items-center gap-2 pl-1">
        <img src="/logo.png" alt="" className="h-7 w-7" draggable={false} />
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
      <Separator orientation="vertical" className="mx-1.5 h-5" />
      <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <Redo2 size={16} />
      </IconButton>
      <Separator orientation="vertical" className="mx-1.5 h-5" />
      <Button variant="ghost" size="sm" onClick={() => importDialog(false)} title="Import media (Ctrl+I)">
        <Upload size={14} /> Import
      </Button>
      <Button variant="ghost" size="sm" onClick={() => set({ joinOpen: true })} title="Join same-format files losslessly (Ctrl+J)">
        <Merge size={14} /> Quick Join
      </Button>

      <ProjectName />

      <EncoderChip />
      <ThemeToggle />
      <Button onClick={() => set({ exportOpen: true })} disabled={!hasClips} title="Export (Ctrl+E)" className="ml-1 px-4">
        <Zap size={14} fill="currentColor" /> Export
      </Button>
    </header>
  );
}

const THEME_ICON: Record<ThemePref, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };

function ThemeToggle() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  const Icon = THEME_ICON[pref];
  return (
    <IconButton
      label={`Theme: ${THEME_LABEL[pref]} (click for ${THEME_LABEL[nextThemePref(pref)]})`}
      onClick={() => setPref(nextThemePref(pref))}
    >
      <Icon size={15} />
    </IconButton>
  );
}

/** Project title in the centre of the bar; click to rename (exports and Save As default to this name). */
function ProjectName() {
  const name = useProject((s) => s.project.name);
  const dirty = useProject((s) => s.dirty);
  const patch = useProject((s) => s.patch);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelled = useRef(false);

  const commit = () => {
    setEditing(false);
    if (cancelled.current) return;
    const next = draft.trim().replace(/[\\/:*?"<>|]/g, "_");
    if (next !== (name ?? "")) patch((d) => void (d.name = next));
  };

  return (
    <div className="mx-auto flex min-w-0 items-center gap-1.5 text-[13px]">
      {editing ? (
        <Input
          autoFocus
          aria-label="Project name"
          placeholder="Untitled"
          value={draft}
          maxLength={80}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          className="h-8 w-60 rounded-[10px] bg-card text-center text-[13px]"
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          title="Click to rename the project"
          onClick={() => {
            cancelled.current = false;
            setDraft(name ?? "");
            setEditing(true);
          }}
          className="h-8 max-w-72 min-w-0 rounded-[10px] px-3 text-[13px] font-normal text-foreground/90"
        >
          <span className="truncate">{name || "Untitled"}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-primary" title="Unsaved changes" />}
        </Button>
      )}
    </div>
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
      <Badge variant="secondary" className="h-7 gap-1.5 px-2.5 text-[11px] font-normal text-muted-foreground" title="Measuring which encoders are fastest on this PC (runs once)">
        <Spinner className="size-3" /> Tuning encoders…
      </Badge>
    );
  }
  if (!report) return null;
  const summary = Object.entries(report.best)
    .map(([codec, enc]) => `${CODEC_LABEL[codec as keyof typeof CODEC_LABEL]}: ${enc}`)
    .join("\n");
  const hw = report.results.filter((r) => r.ok && r.hardware).map((r) => r.encoder);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={rerun}
      className="text-[11px] text-muted-foreground"
      title={`Fastest encoders on this PC:\n${summary}\n\n${report.ffmpegVersion}\nClick to re-run the benchmark.`}
    >
      <Gauge size={13} className={hw.length ? "text-ok" : "text-muted-foreground"} />
      {hw.length ? `GPU: ${hw.map((h) => h.split("_")[1]).filter((v, i, a) => a.indexOf(v) === i).join(", ").toUpperCase()}` : "CPU encoding"}
    </Button>
  );
}
