// Derived, non-persistent data: thumbnails, waveforms, proxy status, encoder report, export jobs.
import { create } from "zustand";
import type { EncoderReport, ExportSettings, Thumbnails } from "@/lib/types";

export type ProxyStatus = "none" | "pending" | "ready" | "error";

export interface ExportJob {
  id: string;
  label: string;
  output: string;
  settings: ExportSettings | null;
  duration: number;
  status: "running" | "done" | "error" | "cancelled";
  progress: number;
  fps: number;
  etaSecs: number;
  stage: string;
  error?: string | null;
  elapsedSecs?: number;
  sizeBytes?: number;
  encoder?: string;
}

interface RuntimeState {
  thumbs: Record<string, { meta: Thumbnails; img: HTMLImageElement }>;
  waveforms: Record<string, Uint8Array>;
  proxy: Record<string, ProxyStatus>;
  encoders: EncoderReport | null;
  benchmarking: boolean;
  jobs: ExportJob[];
  set: (p: Partial<RuntimeState>) => void;
  updateJob: (id: string, p: Partial<ExportJob>) => void;
}

export const useRuntime = create<RuntimeState>((set) => ({
  thumbs: {},
  waveforms: {},
  proxy: {},
  encoders: null,
  benchmarking: false,
  jobs: [],
  set: (p) => set(p),
  updateJob: (id, p) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) })),
}));

export const runtime = () => useRuntime.getState();
