import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, fileUrl, ipc } from "@/lib/ipc";
import { TaskQueue } from "@/lib/queue";
import { uid } from "@/lib/time";
import type { MediaItem } from "@/lib/types";
import { appendMedia, normaliseFps } from "@/store/ops";
import { getProject, useProject } from "@/store/project";
import { runtime, useRuntime } from "@/store/runtime";
import { ui } from "@/store/ui";

// Thumbnails/waveforms are cheap (keyframe-only decode); proxies are heavy, so one at a time.
const lightQueue = new TaskQueue(3);
const proxyQueue = new TaskQueue(1);

const SUPPORTED = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

export function isSupported(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED.has(ext);
}

/** Probe files, add them to the bin, optionally append to the timeline (joiner). */
export async function importPaths(paths: string[], opts: { append?: boolean } = {}): Promise<MediaItem[]> {
  const wanted = paths.filter(isSupported);
  const skipped = paths.length - wanted.length;
  if (!wanted.length) {
    if (skipped) ui().notify("Unsupported file type", "error");
    return [];
  }
  const existing = new Map(getProject().media.map((m) => [m.path, m]));
  const fresh = wanted.filter((p) => !existing.has(p));
  const results = fresh.length ? await ipc.probeMedia(fresh) : [];
  const added: MediaItem[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.info) added.push({ ...r.info, id: uid("m_"), proxyPath: null });
    else errors.push(`${r.path.split(/[\/]/).pop()}: ${r.error}`);
  }
  const { project, patch, edit } = useProject.getState();
  const adoptFormat = project.clips.length === 0 && project.media.length === 0;
  if (added.length) {
    patch((d) => {
      d.media.push(...added);
      const firstVideo = added.find((m) => m.hasVideo);
      if (adoptFormat && firstVideo) {
        // First import defines the canvas, like most editors.
        d.width = firstVideo.width - (firstVideo.width % 2);
        d.height = firstVideo.height - (firstVideo.height % 2);
        d.fps = normaliseFps(firstVideo.fps);
      }
    });
  }
  // Preserve the user's order, including files that were already in the bin.
  const byPath = new Map([...existing, ...added.map((m) => [m.path, m] as const)]);
  const ordered = wanted.map((p) => byPath.get(p)).filter((m): m is MediaItem => !!m);
  if (opts.append && ordered.length) {
    edit((d) => {
      const ids = appendMedia(d, ordered as MediaItem[]);
      ui().select(ids);
    });
  }
  if (errors.length) ui().notify(errors.join("\n"), "error");
  else if (added.length) ui().notify(`Imported ${added.length} file${added.length > 1 ? "s" : ""}`);
  for (const m of added) prepareMedia(m);
  return ordered;
}

/** Background work per media item: thumbnails, waveform, proxy. Safe to call again (cached). */
export function prepareMedia(m: MediaItem) {
  if (m.hasVideo && !runtime().thumbs[m.id]) {
    lightQueue
      .run(() => ipc.generateThumbnails(m))
      .then(
        (meta) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              useRuntime.setState((s) => ({ thumbs: { ...s.thumbs, [m.id]: { meta, img } } }));
              resolve();
            };
            img.onerror = () => resolve();
            img.src = fileUrl(meta.path);
          }),
      )
      .catch((e) => console.warn("thumbnails failed", m.name, e));
  }
  if (m.hasAudio && !runtime().waveforms[m.id]) {
    lightQueue
      .run(() => ipc.generateWaveform(m.path))
      .then((peaks) => useRuntime.setState((s) => ({ waveforms: { ...s.waveforms, [m.id]: Uint8Array.from(peaks) } })))
      .catch((e) => console.warn("waveform failed", m.name, e));
  }
  void ensureProxy(m);
}

async function ensureProxy(m: MediaItem) {
  const setStatus = (st: "none" | "pending" | "ready" | "error") =>
    useRuntime.setState((s) => ({ proxy: { ...s.proxy, [m.id]: st } }));
  if (m.proxyPath) {
    const [exists] = await ipc.filesExist([m.proxyPath]);
    if (exists) return setStatus("ready");
  }
  const needs = await ipc.checkNeedsProxy(m);
  if (!needs) return setStatus("none");
  setStatus("pending");
  try {
    const path = await proxyQueue.run(() => ipc.generateProxy(m));
    // A regenerated cache file is not a user edit.
    useProject.getState().patch(
      (d) => {
        const item = d.media.find((x) => x.id === m.id);
        if (item) item.proxyPath = path;
      },
      { dirty: false },
    );
    setStatus("ready");
  } catch (e) {
    console.warn("proxy failed", m.name, e);
    setStatus("error");
  }
}
