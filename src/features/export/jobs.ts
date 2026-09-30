import { ipc } from "@/lib/ipc";
import { uid } from "@/lib/time";
import type { ExportDoneEvent, ExportProgressEvent, ExportSettings, Project } from "@/lib/types";
import { runtime, useRuntime } from "@/store/runtime";
import { ui } from "@/store/ui";
import { listen } from "@tauri-apps/api/event";

let listening = false;

export async function listenToJobs() {
  if (listening) return;
  listening = true;
  await listen<ExportProgressEvent>("export://progress", ({ payload: p }) => {
    runtime().updateJob(p.jobId, { progress: p.progress, fps: p.fps, etaSecs: p.etaSecs, stage: p.stage });
  });
  await listen<ExportDoneEvent>("export://done", ({ payload: d }) => {
    runtime().updateJob(d.jobId, {
      status: d.ok ? "done" : d.cancelled ? "cancelled" : "error",
      progress: d.ok ? 1 : runtime().jobs.find((j) => j.id === d.jobId)?.progress ?? 0,
      error: d.error,
      elapsedSecs: d.elapsedSecs,
      sizeBytes: d.sizeBytes,
      encoder: d.encoder,
      stage: d.ok ? "Done" : d.cancelled ? "Cancelled" : "Failed",
    });
    const name = d.output.split(/[\\/]/).pop();
    if (d.ok) ui().notify(`Exported ${name} in ${d.elapsedSecs.toFixed(1)}s`);
    else if (!d.cancelled) ui().notify(`Export failed: ${d.error ?? "unknown error"}`, "error");
  });
}

export async function startExport(project: Project, settings: ExportSettings, duration: number) {
  const id = uid("job_");
  useRuntime.setState((s) => ({
    jobs: [
      ...s.jobs,
      {
        id,
        kind: "export",
        label: settings.outputPath.split(/[\\/]/).pop() ?? "export",
        output: settings.outputPath,
        settings,
        duration,
        status: "running",
        progress: 0,
        fps: 0,
        etaSecs: -1,
        stage: "Queued",
      },
    ],
  }));
  try {
    await ipc.startExport(id, project, settings);
  } catch (e) {
    runtime().updateJob(id, { status: "error", error: String(e), stage: "Failed" });
    ui().notify(String(e), "error");
  }
}

export async function startQuickJoin(paths: string[], output: string, duration: number) {
  const id = uid("job_");
  useRuntime.setState((s) => ({
    jobs: [
      ...s.jobs,
      {
        id,
        kind: "export",
        label: output.split(/[\\/]/).pop() ?? "join",
        output,
        settings: null,
        duration,
        status: "running",
        progress: 0,
        fps: 0,
        etaSecs: -1,
        stage: "Joining",
      },
    ],
  }));
  try {
    await ipc.quickJoin(id, paths, output);
  } catch (e) {
    runtime().updateJob(id, { status: "error", error: String(e), stage: "Failed" });
  }
}

export function clearFinished() {
  useRuntime.setState((s) => ({ jobs: s.jobs.filter((j) => j.status === "running") }));
}
