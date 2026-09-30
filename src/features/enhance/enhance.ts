// "Enhance voice": model catalogue, download → render jobs, and wiring results onto clips.
import { ipc } from "@/lib/ipc";
import { shortDuration, uid } from "@/lib/time";
import type {
  Enhance,
  EnhanceDoneEvent,
  EnhanceModelId,
  EnhanceStrength,
  ExportProgressEvent,
  MediaItem,
  ModelDoneEvent,
} from "@/lib/types";
import * as ops from "@/store/ops";
import { getProject, useProject } from "@/store/project";
import { runtime, useRuntime } from "@/store/runtime";
import { ui } from "@/store/ui";
import { listen } from "@tauri-apps/api/event";

export interface ModelInfo {
  id: EnhanceModelId;
  name: string;
  tagline: string;
  fixes: string;
  /** Strength (attenuation limit) is meaningful for mask-based models only. */
  hasStrength: boolean;
}

/** Numbers come from bench/audio-enhance/results.md. */
export const MODELS: ModelInfo[] = [
  {
    id: "dfn3",
    name: "Fast",
    tagline: "DeepFilterNet3 · ~25× real time",
    fixes: "Removes background noise: fans, traffic, hum, keyboard. Best all-round default.",
    hasStrength: true,
  },
  {
    id: "dpdfnet2",
    name: "Strong",
    tagline: "DPDFNet-2 · ~8× real time",
    fixes: "Stronger noise removal for busy real-world recordings.",
    hasStrength: true,
  },
  {
    id: "sidon",
    name: "Restore",
    tagline: "Sidon · ~2× real time · generative",
    fixes: "Rebuilds the voice: removes echo/reverb and fixes phone-quality or muffled audio.",
    hasStrength: false,
  },
];

export const modelInfo = (id: EnhanceModelId) => MODELS.find((m) => m.id === id)!;

export async function refreshModels() {
  try {
    useRuntime.setState({ enhanceModels: await ipc.enhanceModels() });
  } catch (e) {
    console.warn("enhance_models failed", e);
  }
}

/** Pending renders waiting for a model download: jobId of the download → callbacks. */
const afterDownload = new Map<string, { render: () => void; restore: () => void }>();
/** Render jobs by id → what to attach on completion (and what to restore if it fails). */
const renders = new Map<
  string,
  { mediaPath: string; model: EnhanceModelId; strength: EnhanceStrength; previous: Map<string, Enhance | null> }
>();

let listening = false;

export async function listenToEnhance() {
  if (listening) return;
  listening = true;
  void refreshModels();
  const onProgress = ({ payload: p }: { payload: ExportProgressEvent }) =>
    runtime().updateJob(p.jobId, { progress: p.progress, etaSecs: p.etaSecs, stage: p.stage });
  await listen<ExportProgressEvent>("enhance://progress", onProgress);
  await listen<ExportProgressEvent>("model://progress", onProgress);

  await listen<EnhanceDoneEvent>("enhance://done", ({ payload: d }) => {
    const req = renders.get(d.jobId);
    renders.delete(d.jobId);
    if (!d.ok && req) restorePrevious(req.previous, d.model, d.strength);
    finishJob(d.jobId, d.ok, d.cancelled, d.error, d.elapsedSecs);
    if (d.ok && d.path) {
      useProject.getState().patch((p) => ops.attachEnhanced(p, d.mediaPath, d.model, d.strength, d.path!));
      ui().notify(`Voice enhanced in ${shortDuration(d.elapsedSecs, true)}`);
    } else if (!d.cancelled) {
      ui().notify(`Enhance failed: ${d.error ?? "unknown error"}`, "error");
    }
  });

  await listen<ModelDoneEvent>("model://done", ({ payload: d }) => {
    finishJob(d.jobId, d.ok, d.cancelled, d.error);
    void refreshModels();
    const next = afterDownload.get(d.jobId);
    afterDownload.delete(d.jobId);
    if (d.ok) {
      next?.render();
    } else {
      next?.restore();
      if (!d.cancelled) ui().notify(`Model download failed: ${d.error ?? "unknown error"}`, "error");
    }
  });
}

function finishJob(id: string, ok: boolean, cancelled: boolean, error: string | null, elapsedSecs?: number) {
  runtime().updateJob(id, {
    status: ok ? "done" : cancelled ? "cancelled" : "error",
    ...(ok ? { progress: 1 } : {}),
    error,
    elapsedSecs,
    stage: ok ? "Done" : cancelled ? "Cancelled" : "Failed",
  });
}

function addJob(id: string, kind: "enhance" | "download", label: string, duration: number) {
  useRuntime.setState((s) => ({
    jobs: [
      ...s.jobs,
      { id, kind, label, output: "", settings: null, duration, status: "running", progress: 0, fps: 0, etaSecs: -1, stage: "Queued" },
    ],
  }));
}

/** Estimated processing time for `media` with `model`, from the measured real-time factor. */
export function estimateSecs(model: EnhanceModelId, media: MediaItem[]): number {
  const rtf = runtime().enhanceModels.find((m) => m.id === model)?.rtf ?? 0.5;
  return media.reduce((s, m) => s + m.duration * rtf, 0);
}

/**
 * Enhance the voice of the given clips. Clips from the same media file are rendered once;
 * cached renders attach instantly. Downloads the model first if needed.
 */
export async function enhanceClips(clipIds: string[], model: EnhanceModelId, strength: EnhanceStrength) {
  const st = modelInfo(model).hasStrength ? strength : "full";
  const previous = new Map(
    getProject()
      .clips.filter((c) => clipIds.includes(c.id))
      .map((c) => [c.id, c.enhance ? { ...c.enhance } : null] as const),
  );
  useProject.getState().edit((p) => ops.setEnhance(p, clipIds, { model, strength: st, path: null }));
  const p = getProject();
  const mediaIds = new Set(p.clips.filter((c) => clipIds.includes(c.id)).map((c) => c.mediaId));
  const media = p.media.filter((m) => mediaIds.has(m.id) && m.hasAudio);

  const renderAll = async () => {
    for (const m of media) {
      const cached = await ipc.enhancedPath(m.path, model, st);
      if (cached) {
        useProject.getState().patch((d) => ops.attachEnhanced(d, m.path, model, st, cached));
        continue;
      }
      const jobId = uid("enh_");
      const mine = new Map([...previous].filter(([id]) => p.clips.find((c) => c.id === id)?.mediaId === m.id));
      renders.set(jobId, { mediaPath: m.path, model, strength: st, previous: mine });
      addJob(jobId, "enhance", `${modelInfo(model).name} · ${m.name}`, m.duration);
      try {
        await ipc.startEnhance(jobId, m.path, m.duration, model, st);
      } catch (e) {
        finishJob(jobId, false, false, String(e));
      }
    }
  };

  const status = runtime().enhanceModels.find((m) => m.id === model);
  if (status && !status.installed) {
    const jobId = uid("dl_");
    afterDownload.set(jobId, { render: () => void renderAll(), restore: () => restorePrevious(previous, model, st) });
    addJob(jobId, "download", `Downloading ${modelInfo(model).name} model`, 0);
    try {
      await ipc.downloadModel(jobId, model);
    } catch (e) {
      afterDownload.delete(jobId);
      finishJob(jobId, false, false, String(e));
    }
    return;
  }
  await renderAll();
}

const waveRequested = new Set<string>();

/** Waveform of an enhanced render (keyed "enh:<path>"), generated once on demand. */
export function enhancedWaveform(path: string): Uint8Array | undefined {
  const key = `enh:${path}`;
  const w = runtime().waveforms[key];
  if (!w && !waveRequested.has(key)) {
    waveRequested.add(key);
    ipc
      .generateWaveform(path)
      .then((peaks) => useRuntime.setState((s) => ({ waveforms: { ...s.waveforms, [key]: Uint8Array.from(peaks) } })))
      .catch(() => waveRequested.delete(key));
  }
  return w;
}

/** A cancelled/failed render puts clips back to what they had (e.g. an earlier model's result). */
function restorePrevious(previous: Map<string, Enhance | null>, model: EnhanceModelId, strength: EnhanceStrength) {
  useProject.getState().patch((p) => {
    for (const c of p.clips) {
      if (!previous.has(c.id)) continue;
      // Only undo clips still waiting on this exact request.
      if (c.enhance?.model === model && c.enhance.strength === strength && !c.enhance.path) {
        c.enhance = previous.get(c.id) ?? null;
      }
    }
  });
}

export function removeEnhance(clipIds: string[]) {
  useProject.getState().edit((p) => ops.setEnhance(p, clipIds, null));
}

/** Is a render or download running for these clips' media/model? */
export function pendingFor(mediaPaths: string[], model: EnhanceModelId): boolean {
  return [...renders.values()].some((r) => r.model === model && mediaPaths.includes(r.mediaPath));
}

/** After opening a project: re-link cached renders, and clear paths whose files are gone. */
export async function relinkEnhanced() {
  const p = getProject();
  const withEnhance = p.clips.filter((c) => c.enhance);
  if (!withEnhance.length) return;
  const paths = withEnhance.map((c) => c.enhance!.path ?? "");
  const exists = await ipc.filesExist(paths);
  const missing = withEnhance.filter((_, i) => !exists[i]);
  for (const c of missing) {
    const m = p.media.find((x) => x.id === c.mediaId);
    const cached = m && (await ipc.enhancedPath(m.path, c.enhance!.model, c.enhance!.strength));
    useProject.getState().patch(
      (d) => {
        const clip = d.clips.find((x) => x.id === c.id);
        if (clip?.enhance) clip.enhance.path = cached ?? null;
      },
      { dirty: false },
    );
  }
}
