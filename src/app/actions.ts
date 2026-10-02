// User-facing commands shared by keyboard shortcuts, toolbars and menus.
import { relinkEnhanced } from "@/features/enhance/enhance";
import { importPaths, prepareMedia } from "@/features/media-bin/importer";
import { engine } from "@/features/preview/engine";
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, ipc } from "@/lib/ipc";
import { snapToFrame } from "@/lib/time";
import type { Project } from "@/lib/types";
import * as ops from "@/store/ops";
import { getProject, useProject } from "@/store/project";
import { ui, useUi } from "@/store/ui";
import { ask, open, save } from "@tauri-apps/plugin-dialog";

const FILE_TAG = "beaver-video-editor";

const edit = (fn: (d: Project) => void) => useProject.getState().edit(fn);

export function stepFrames(n: number) {
  const p = getProject();
  if (ui().playing) engine.pause();
  ui().seek(snapToFrame(ui().playhead + n / p.fps, p.fps));
}

export function seekBy(seconds: number) {
  ui().seek(Math.max(0, ui().playhead + seconds));
}

/** Clips under the playhead to split: selection if any, otherwise every unlocked track. */
export function splitAtPlayhead(allTracks = false) {
  const p = getProject();
  const t = snapToFrame(ui().playhead, p.fps);
  const sel = ui().selection;
  const under = ops.clipsAt(p, t);
  const targets = !allTracks && sel.length ? under.filter((c) => sel.includes(c.id)) : under;
  if (!targets.length) return ui().notify("Nothing under the playhead to split");
  edit((d) => void ops.splitClips(d, targets.map((c) => c.id), t));
  // Neither half stays selected: the user picks the one they want next.
  if (sel.length) ui().select([]);
}

export function splitClipAt(clipId: string, t: number) {
  const p = getProject();
  edit((d) => void ops.splitClips(d, [clipId], snapToFrame(t, p.fps)));
}

export function deleteSelection(ripple = ui().ripple) {
  const { selection, inPoint, outPoint } = ui();
  if (selection.length) {
    edit((d) => ops.deleteClips(d, selection, ripple));
    ui().select([]);
  } else if (inPoint != null && outPoint != null && outPoint > inPoint) {
    deleteInOut(ripple);
  }
}

/** Cutter: remove the marked In→Out range from every unlocked track. */
export function deleteInOut(ripple = true) {
  const { inPoint, outPoint } = ui();
  if (inPoint == null || outPoint == null || outPoint <= inPoint) {
    return ui().notify("Mark In (I) and Out (O) first", "error");
  }
  edit((d) => ops.deleteRange(d, inPoint, outPoint, ripple));
  ui().set({ inPoint: null, outPoint: null, selection: [], playhead: inPoint });
}

export function trimToPlayhead(side: "start" | "end") {
  const p = getProject();
  const t = snapToFrame(ui().playhead, p.fps);
  const sel = ui().selection;
  const targets = sel.length ? sel : ops.clipsAt(p, t).map((c) => c.id);
  edit((d) => ops.trimToPlayhead(d, targets, t, side));
}

export function selectAll() {
  ui().select(getProject().clips.map((c) => c.id));
}

export function undo() {
  useProject.getState().undo();
  pruneSelection();
}

export function redo() {
  useProject.getState().redo();
  pruneSelection();
}

function pruneSelection() {
  const ids = new Set(getProject().clips.map((c) => c.id));
  ui().select(ui().selection.filter((id) => ids.has(id)));
}

export function zoomBy(factor: number, anchorTime?: number) {
  const { pxPerSec, scrollX, playhead } = ui();
  const anchor = anchorTime ?? playhead;
  const next = Math.min(800, Math.max(2, pxPerSec * factor));
  // Keep the anchor time at the same screen position.
  const anchorPx = (anchor - scrollX) * pxPerSec;
  ui().set({ pxPerSec: next, scrollX: Math.max(0, anchor - anchorPx / next) });
}

export function zoomToFit(viewportPx: number) {
  const dur = Math.max(5, ops.projectDuration(getProject()));
  ui().set({ pxPerSec: Math.min(800, Math.max(2, (viewportPx - 40) / dur)), scrollX: 0 });
}

export function setSpeed(ids: string[], speed: number) {
  if (ids.length) edit((d) => ops.setSpeed(d, ids, speed));
}

export function detachAudio(id: string) {
  edit((d) => {
    const created = ops.detachAudio(d, id);
    if (created) ui().select([id, created]);
  });
}

export async function importDialog(append = false) {
  const picked = await open({
    multiple: true,
    title: "Import media",
    filters: [
      { name: "Media", extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
      { name: "Video", extensions: VIDEO_EXTENSIONS },
      { name: "Audio", extensions: AUDIO_EXTENSIONS },
    ],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  await importPaths(paths, { append });
}

export function appendSelectedMedia() {
  const { selectedMedia } = ui();
  const p = getProject();
  const media = p.media.filter((m) => selectedMedia.includes(m.id));
  if (!media.length) return;
  edit((d) => ui().select(ops.appendMedia(d, media)));
}

// ---------- project files ----------

export function serialize(p: Project) {
  return JSON.stringify({ app: FILE_TAG, version: 1, project: p }, null, 1);
}

function parse(text: string): Project {
  const data = JSON.parse(text);
  if (data?.app !== FILE_TAG || !data.project) throw new Error("Not a Beaver project file");
  return data.project as Project;
}

async function confirmDiscard() {
  if (!useProject.getState().dirty || getProject().clips.length === 0) return true;
  return ask("You have unsaved changes. Discard them?", { title: "Unsaved changes", kind: "warning" });
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  engine.pause();
  useProject.getState().load(ops.createProject(), null);
  useUi.setState({ playhead: 0, selection: [], selectedMedia: [], inPoint: null, outPoint: null, scrollX: 0 });
  void ipc.clearAutosave();
}

export async function openProject(path?: string) {
  if (!(await confirmDiscard())) return;
  const file =
    path ??
    (await open({ title: "Open project", filters: [{ name: "Beaver project", extensions: ["beaver"] }] }));
  if (!file || Array.isArray(file)) return;
  try {
    loadProjectData(parse(await ipc.loadProject(file)), file);
  } catch (e) {
    ui().notify(String(e), "error");
  }
}

export async function loadProjectData(p: Project, path: string | null) {
  engine.pause();
  useProject.getState().load(p, path);
  useUi.setState({ playhead: 0, selection: [], selectedMedia: [], inPoint: null, outPoint: null, scrollX: 0 });
  const exists = await ipc.filesExist(p.media.map((m) => m.path));
  const missing = p.media.filter((_, i) => !exists[i]);
  if (missing.length) {
    ui().notify(`Missing media: ${missing.map((m) => m.name).join(", ")}`, "error");
  }
  p.media.filter((_, i) => exists[i]).forEach(prepareMedia);
  void relinkEnhanced();
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const state = useProject.getState();
  let path = state.filePath;
  if (!path || saveAs) {
    const picked = await save({
      title: "Save project",
      defaultPath: `${state.project.name || "Untitled"}.beaver`,
      filters: [{ name: "Beaver project", extensions: ["beaver"] }],
    });
    if (!picked) return false;
    path = picked;
  }
  try {
    const name = path.split(/[\\/]/).pop()!.replace(/\.beaver$/i, "");
    let project = getProject();
    if (!state.filePath || saveAs) {
      useProject.getState().patch((d) => void (d.name = name));
      project = getProject();
    }
    await ipc.saveProject(path, serialize(project));
    useProject.getState().markSaved(path);
    void ipc.clearAutosave();
    ui().notify("Project saved");
    return true;
  } catch (e) {
    ui().notify(`Save failed: ${e}`, "error");
    return false;
  }
}

export function restoreAutosave(text: string) {
  try {
    loadProjectData(parse(text), null);
    useProject.setState({ dirty: true });
  } catch (e) {
    ui().notify(String(e), "error");
  }
}
