import { IconButton } from "@/components/ui";
import { ipc } from "@/lib/ipc";
import { formatBytes, shortDuration } from "@/lib/time";
import { useRuntime, type ExportJob } from "@/store/runtime";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import { CheckCircle2, ChevronDown, ChevronUp, CircleX, FolderOpen, Loader2, X } from "lucide-react";
import { useState } from "react";
import { clearFinished } from "./jobs";

/** Floating panel listing running and finished exports. */
export function ExportQueue() {
  const jobs = useRuntime((s) => s.jobs);
  const [collapsed, setCollapsed] = useState(false);
  if (!jobs.length) return null;
  const running = jobs.filter((j) => j.status === "running").length;

  return (
    <div className="fixed right-4 bottom-4 z-40 w-[380px] overflow-hidden rounded-xl border border-line bg-panel-2 shadow-2xl">
      <div className="flex h-9 items-center justify-between border-b border-line pr-1 pl-3">
        <span className="text-xs font-semibold">
          {running ? `Working on ${running}…` : "Background jobs"}
        </span>
        <div className="flex">
          <IconButton label={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </IconButton>
          {!running && (
            <IconButton label="Clear finished" onClick={clearFinished}>
              <X size={14} />
            </IconButton>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="max-h-72 overflow-y-auto">
          {jobs
            .slice()
            .reverse()
            .map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
        </div>
      )}
    </div>
  );
}

function JobRow({ job }: { job: ExportJob }) {
  const pct = Math.round(job.progress * 100);
  const realtime = job.elapsedSecs && job.duration ? job.duration / job.elapsedSecs : 0;
  return (
    <div className="border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        {job.status === "running" && <Loader2 size={14} className="spin shrink-0 text-accent" />}
        {job.status === "done" && <CheckCircle2 size={14} className="shrink-0 text-ok" />}
        {(job.status === "error" || job.status === "cancelled") && <CircleX size={14} className="shrink-0 text-danger" />}
        <span className="min-w-0 flex-1 truncate text-[13px]" title={job.output}>
          {job.label}
        </span>
        {job.status === "running" ? (
          <button onClick={() => ipc.cancelExport(job.id)} className="rounded px-1.5 text-[11px] text-muted hover:bg-danger/15 hover:text-danger">
            Cancel
          </button>
        ) : job.status === "done" && (job.kind ?? "export") === "export" ? (
          <IconButton label="Show in folder" onClick={() => revealItemInDir(job.output)}>
            <FolderOpen size={13} />
          </IconButton>
        ) : null}
      </div>
      {job.status === "running" && (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
            <span>
              {job.stage} · {pct}%
            </span>
            <span>
              {job.fps > 0 && `${Math.round(job.fps)} fps · `}
              {job.etaSecs >= 0 ? `${shortDuration(job.etaSecs)} left` : "…"}
            </span>
          </div>
        </>
      )}
      {job.status === "done" && (job.kind ?? "export") !== "export" && (
        <div className="mt-1 font-mono text-[10px] text-muted">
          {job.kind === "download" ? "Downloaded" : "Enhanced"} in {shortDuration(job.elapsedSecs ?? 0, true)}
        </div>
      )}
      {job.status === "done" && (job.kind ?? "export") === "export" && (
        <div className="mt-1 font-mono text-[10px] text-muted">
          {shortDuration(job.elapsedSecs ?? 0, true)}
          {realtime > 0 && <span className={clsx(realtime >= 1 && "text-ok")}> · {realtime.toFixed(1)}× realtime</span>} ·{" "}
          {formatBytes(job.sizeBytes ?? 0)} · {job.encoder}
        </div>
      )}
      {job.status === "error" && (
        <pre className="mt-1 max-h-24 overflow-auto font-mono text-[10px] whitespace-pre-wrap text-danger/90 select-text">{job.error}</pre>
      )}
    </div>
  );
}
