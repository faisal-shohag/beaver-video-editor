import { engine } from "@/features/preview/engine";
import { timelineViewportWidth } from "@/features/timeline/Timeline";
import { snapToFrame } from "@/lib/time";
import * as ops from "@/store/ops";
import { getProject } from "@/store/project";
import { ui } from "@/store/ui";
import {
  deleteInOut,
  deleteSelection,
  importDialog,
  newProject,
  openProject,
  redo,
  saveProject,
  seekBy,
  selectAll,
  splitAtPlayhead,
  stepFrames,
  trimToPlayhead,
  undo,
  zoomBy,
  zoomToFit,
} from "./actions";

/** Jump to the previous/next clip boundary. */
function jumpEdit(dir: 1 | -1) {
  const p = getProject();
  const t = ui().playhead;
  const edges = [0, ...p.clips.flatMap((c) => [c.start, ops.clipEnd(c)])].sort((a, b) => a - b);
  const target = dir > 0 ? edges.find((e) => e > t + 1e-3) : [...edges].reverse().find((e) => e < t - 1e-3);
  if (target != null) ui().seek(snapToFrame(target, p.fps));
}

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const u = ui();
    const target = e.target as HTMLElement;
    const typing = target.closest("input, textarea, select, [contenteditable=true]");
    if (typing || u.exportOpen || u.joinOpen) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;

    if (ctrl) {
      if (key === "z" && e.shiftKey) redo();
      else if (key === "z") undo();
      else if (key === "y") redo();
      else if (key === "s") void saveProject(e.shiftKey);
      else if (key === "o") void openProject();
      else if (key === "n") void newProject();
      else if (key === "i") void importDialog(false);
      else if (key === "e") u.set({ exportOpen: true });
      else if (key === "j") u.set({ joinOpen: true });
      else if (key === "a") selectAll();
      else handled = false;
    } else if (e.altKey) {
      if (key === "x") u.set({ inPoint: null, outPoint: null });
      else handled = false;
    } else {
      switch (e.key) {
        case " ":
          engine.toggle();
          break;
        case "k":
        case "K":
          engine.pause();
          break;
        case "l":
        case "L":
          if (!u.playing) engine.play();
          else u.set({ shuttle: u.shuttle >= 4 ? 1 : u.shuttle * 2 });
          break;
        case "j":
        case "J":
          engine.pause();
          seekBy(-1);
          break;
        case "ArrowLeft":
          if (e.shiftKey) seekBy(-1);
          else stepFrames(-1);
          break;
        case "ArrowRight":
          if (e.shiftKey) seekBy(1);
          else stepFrames(1);
          break;
        case "ArrowUp":
          jumpEdit(-1);
          break;
        case "ArrowDown":
          jumpEdit(1);
          break;
        case "Home":
          u.seek(0);
          break;
        case "End":
          u.seek(ops.projectDuration(getProject()));
          break;
        case "s":
          splitAtPlayhead(false);
          break;
        case "S":
          splitAtPlayhead(true);
          break;
        case "b":
        case "B":
          u.set({ tool: "blade" });
          break;
        case "v":
        case "V":
          u.set({ tool: "select" });
          break;
        case "n":
        case "N":
          u.set({ snap: !u.snap });
          break;
        case "i":
        case "I":
          u.set({ inPoint: snapToFrame(u.playhead, getProject().fps) });
          break;
        case "o":
        case "O":
          u.set({ outPoint: snapToFrame(u.playhead, getProject().fps) });
          break;
        case "q":
        case "Q":
          trimToPlayhead("start");
          break;
        case "w":
        case "W":
          trimToPlayhead("end");
          break;
        case "Delete":
        case "Backspace": {
          // Shift+Del: a marked In/Out range is cut first; otherwise ripple-delete the selection.
          const hasRange = u.inPoint != null && u.outPoint != null && u.outPoint > u.inPoint;
          if (e.shiftKey && hasRange) deleteInOut(true);
          else deleteSelection(e.shiftKey || u.ripple);
          break;
        }
        case "Escape":
          u.set({ selection: [], tool: "select" });
          break;
        case "+":
        case "=":
          zoomBy(1.4);
          break;
        case "-":
        case "_":
          zoomBy(1 / 1.4);
          break;
        case "\\":
          zoomToFit(timelineViewportWidth());
          break;
        default:
          handled = false;
      }
    }
    if (handled) e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
