import { Button, Segmented } from "@/components/ui";
import { ipc } from "@/lib/ipc";
import { formatBytes, shortDuration } from "@/lib/time";
import type { Clip, EnhanceModelId, EnhanceStrength, Project } from "@/lib/types";
import { useRuntime } from "@/store/runtime";
import { useUi } from "@/store/ui";
import clsx from "clsx";
import { CheckCircle2, Download, Ear, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MODELS, enhanceClips, estimateSecs, modelInfo, refreshModels, removeEnhance } from "./enhance";

/** Inspector section: pick a model (and strength), enhance, A/B, remove. */
export function EnhancePanel({ clips, project }: { clips: Clip[]; project: Project }) {
  const statuses = useRuntime((s) => s.enhanceModels);
  const jobs = useRuntime((s) => s.jobs);
  const current = clips[0].enhance ?? null;
  const [model, setModel] = useState<EnhanceModelId>(current?.model ?? "dfn3");
  const [strength, setStrength] = useState<EnhanceStrength>(current?.strength ?? "full");

  // Follow the clip's applied settings when the selection or its enhancement changes.
  const selectionKey = clips.map((c) => c.id).join();
  useEffect(() => {
    if (current) {
      setModel(current.model);
      setStrength(current.strength);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, current?.model, current?.strength]);

  useEffect(() => {
    if (!statuses.length) void refreshModels();
  }, [statuses.length]);

  const media = project.media.filter((m) => m.hasAudio && clips.some((c) => c.mediaId === m.id));
  if (!media.length) return null;

  const info = modelInfo(model);
  const effStrength: EnhanceStrength = info.hasStrength ? strength : "full";
  const applied = clips.every((c) => c.enhance?.path && c.enhance.model === model && c.enhance.strength === effStrength);
  const anyEnhanced = clips.some((c) => c.enhance);
  const running = jobs.filter((j) => (j.kind === "enhance" || j.kind === "download") && j.status === "running");
  const status = statuses.find((s) => s.id === model);
  const needsDownload = status && !status.installed;
  const eta = estimateSecs(model, media);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel-2/60 p-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Sparkles size={14} className="text-accent" /> Enhance voice
        </span>
        {anyEnhanced && clips.every((c) => c.enhance?.path) && (
          <span className="flex items-center gap-1 text-[11px] text-ok">
            <CheckCircle2 size={12} /> {modelInfo(clips[0].enhance!.model).name}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Enhancement model">
        {MODELS.map((m) => {
          const st = statuses.find((s) => s.id === m.id);
          return (
            <button
              key={m.id}
              role="radio"
              aria-checked={model === m.id}
              onClick={() => setModel(m.id)}
              className={clsx(
                "rounded-md border px-2.5 py-2 text-left transition-colors",
                model === m.id ? "border-accent bg-accent/8" : "border-line hover:border-line-strong",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={clsx("text-[13px] font-medium", model === m.id && "text-accent")}>{m.name}</span>
                <span className="text-[10px] text-faint">{m.tagline}</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted">{m.fixes}</div>
              {st && !st.installed && (
                <div className="mt-1 flex items-center gap-1 text-[10px] text-accent">
                  <Download size={10} /> Downloads {formatBytes(st.downloadBytes)} on first use
                </div>
              )}
            </button>
          );
        })}
      </div>

      {info.hasStrength && (
        <Segmented<EnhanceStrength>
          value={strength}
          onChange={setStrength}
          options={[
            { value: "light", label: "Light", title: "Keeps some room tone (max 12 dB reduction)" },
            { value: "medium", label: "Medium", title: "Max 24 dB noise reduction" },
            { value: "full", label: "Full", title: "Remove as much noise as possible" },
          ]}
        />
      )}

      {running.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {running.map((j) => (
            <div key={j.id}>
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span className="flex min-w-0 items-center gap-1 truncate">
                  <Loader2 size={11} className="spin shrink-0 text-accent" /> {j.stage}
                </span>
                <button onClick={() => ipc.cancelJob(j.id)} className="rounded px-1 hover:text-danger" aria-label="Cancel">
                  <X size={12} />
                </button>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <Button variant={applied ? "default" : "primary"} disabled={applied} onClick={() => enhanceClips(clips.map((c) => c.id), model, strength)}>
            <Sparkles size={13} />
            {applied ? "Enhanced" : needsDownload ? "Download & enhance" : "Enhance"}
          </Button>
          {!applied && (
            <p className="-mt-1 text-center text-[11px] text-faint">
              ≈ {shortDuration(Math.max(1, eta))} for {media.length > 1 ? `${media.length} files` : "this file"} · original is kept
            </p>
          )}
        </>
      )}

      {anyEnhanced && (
        <div className="flex gap-1.5">
          <HearOriginalButton />
          <Button size="sm" variant="ghost" onClick={() => removeEnhance(clips.map((c) => c.id))}>
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

/** Hold to A/B against the original audio (preview only). */
function HearOriginalButton() {
  const set = useUi((s) => s.set);
  const holding = useUi((s) => s.hearOriginal);
  const release = () => set({ hearOriginal: false });
  return (
    <Button
      size="sm"
      className={clsx("flex-1", holding && "border-accent text-accent")}
      onPointerDown={() => set({ hearOriginal: true })}
      onPointerUp={release}
      onPointerLeave={release}
      title="Hold while playing to hear the original audio"
    >
      <Ear size={13} /> Hold for original
    </Button>
  );
}
