import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "beaver.theme";
/** Fired on `window` after the resolved theme changes (the timeline canvas re-reads its palette). */
export const THEME_EVENT = "beaver:theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)");

export const resolveTheme = (pref: ThemePref): Theme =>
  pref === "system" ? (systemDark().matches ? "dark" : "light") : pref;

function apply(pref: ThemePref) {
  const next = resolveTheme(pref);
  if (document.documentElement.dataset.theme === next) return;
  document.documentElement.dataset.theme = next;
  window.dispatchEvent(new Event(THEME_EVENT));
}

export const useTheme = create<{ pref: ThemePref; setPref: (p: ThemePref) => void }>((set) => ({
  pref: readPref(),
  setPref: (pref) => {
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* storage unavailable */
    }
    set({ pref });
    apply(pref);
  },
}));

const ORDER: ThemePref[] = ["system", "light", "dark"];
export const nextThemePref = (p: ThemePref) => ORDER[(ORDER.indexOf(p) + 1) % ORDER.length];

/** Apply the saved preference and follow OS changes while it is "system". */
export function initTheme() {
  apply(useTheme.getState().pref);
  const mq = systemDark();
  const onChange = () => {
    if (useTheme.getState().pref === "system") apply("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
