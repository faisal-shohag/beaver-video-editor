import { create } from "zustand";

export type Tool = "select" | "blade";

interface UiState {
  playhead: number;
  playing: boolean;
  /** Shuttle multiplier (L key: 1x → 2x → 4x). */
  shuttle: number;
  pxPerSec: number;
  /** Left edge of the timeline viewport, seconds. */
  scrollX: number;
  selection: string[];
  selectedMedia: string[];
  tool: Tool;
  snap: boolean;
  ripple: boolean;
  inPoint: number | null;
  outPoint: number | null;
  exportOpen: boolean;
  joinOpen: boolean;
  /** Media being dragged from the bin (pointer based; HTML5 DnD is blocked by the webview). */
  dragMedia: { ids: string[]; x: number; y: number } | null;
  toast: { id: number; text: string; kind: "info" | "error" } | null;

  set: (p: Partial<UiState>) => void;
  seek: (t: number) => void;
  select: (ids: string[]) => void;
  notify: (text: string, kind?: "info" | "error") => void;
}

export const useUi = create<UiState>((set) => ({
  playhead: 0,
  playing: false,
  shuttle: 1,
  pxPerSec: 60,
  scrollX: 0,
  selection: [],
  selectedMedia: [],
  tool: "select",
  snap: true,
  ripple: false,
  inPoint: null,
  outPoint: null,
  exportOpen: false,
  joinOpen: false,
  dragMedia: null,
  toast: null,

  set: (p) => set(p),
  seek: (t) => set({ playhead: Math.max(0, t) }),
  select: (ids) => set({ selection: ids }),
  notify: (text, kind = "info") => set({ toast: { id: Date.now(), text, kind } }),
}));

export const ui = () => useUi.getState();
