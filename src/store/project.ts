import { create } from "zustand";
import { produce, type Draft } from "immer";
import type { Project } from "@/lib/types";
import { createProject } from "./ops";

const HISTORY_LIMIT = 200;

interface ProjectState {
  project: Project;
  past: Project[];
  future: Project[];
  /** Snapshot taken when a drag gesture started (live edits apply to it). */
  gestureBase: Project | null;
  dirty: boolean;
  filePath: string | null;
  /** Apply an undoable edit. */
  edit: (recipe: (d: Draft<Project>) => void) => void;
  /** Apply a non-undoable change (media bin updates, proxy paths). */
  patch: (recipe: (d: Draft<Project>) => void, opts?: { dirty?: boolean }) => void;
  beginGesture: () => void;
  /** Re-apply `recipe` to the gesture base (not cumulative). */
  updateGesture: (recipe: (d: Draft<Project>) => void) => void;
  endGesture: (commit?: boolean) => void;
  undo: () => void;
  redo: () => void;
  load: (p: Project, path: string | null) => void;
  markSaved: (path: string) => void;
}

// Media is not part of undo: undoing a clip edit must not drop freshly imported files.
const withMedia = (snapshot: Project, current: Project): Project =>
  snapshot.media === current.media ? snapshot : { ...snapshot, media: current.media };

export const useProject = create<ProjectState>((set, get) => ({
  project: createProject(),
  past: [],
  future: [],
  gestureBase: null,
  dirty: false,
  filePath: null,

  edit: (recipe) => {
    const { project, past } = get();
    const next = produce(project, recipe);
    if (next === project) return;
    set({ project: next, past: [...past.slice(-HISTORY_LIMIT + 1), project], future: [], dirty: true });
  },

  patch: (recipe, opts) => {
    const { project, gestureBase, dirty } = get();
    const next = produce(project, recipe);
    if (next === project) return;
    set({
      project: next,
      dirty: opts?.dirty === false ? dirty : true,
      gestureBase: gestureBase && produce(gestureBase, recipe),
    });
  },

  beginGesture: () => set({ gestureBase: get().project }),

  updateGesture: (recipe) => {
    const base = get().gestureBase;
    if (!base) return;
    set({ project: produce(base, recipe) });
  },

  endGesture: (commit = true) => {
    const { gestureBase, project, past } = get();
    if (!gestureBase) return;
    if (!commit) {
      set({ project: gestureBase, gestureBase: null });
    } else if (project !== gestureBase) {
      set({ past: [...past.slice(-HISTORY_LIMIT + 1), gestureBase], future: [], gestureBase: null, dirty: true });
    } else {
      set({ gestureBase: null });
    }
  },

  undo: () => {
    const { past, project, future } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ project: withMedia(prev, project), past: past.slice(0, -1), future: [project, ...future], dirty: true });
  },

  redo: () => {
    const { past, project, future } = get();
    const next = future[0];
    if (!next) return;
    set({ project: withMedia(next, project), past: [...past, project], future: future.slice(1), dirty: true });
  },

  load: (p, path) => set({ project: p, past: [], future: [], gestureBase: null, dirty: false, filePath: path }),

  markSaved: (path) => set({ dirty: false, filePath: path }),
}));

export const getProject = () => useProject.getState().project;
