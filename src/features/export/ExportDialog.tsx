import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppDialog, Field, NumberInput, Segmented, Select } from "@/components/editor";
import { ipc } from "@/lib/ipc";
import { formatBytes, shortDuration, uid } from "@/lib/time";
import type { ExportSettings, Quality } from "@/lib/types";
import { projectDuration } from "@/store/ops";
import { getProject, useProject } from "@/store/project";
import { useRuntime } from "@/store/runtime";
import { useUi } from "@/store/ui";
import { videoDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { Copy, Cpu, FolderOpen, Gauge, Save, Sparkles, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { startExport } from "./jobs";
import {
  AUDIO_CODECS_FOR,
  AUDIO_LABEL,
  BUILTIN_PRESETS,
  CODEC_LABEL,
  CONTAINERS,
  EXT_FOR,
  VIDEO_CODECS_FOR,
  defaultSettings,
  loadLastSettings,
  loadUserPresets,
  normalise,
  saveLastSettings,
  saveUserPresets,
  type Preset,
} from "./presets";

const HEIGHTS = [
  { value: "0", label: "Project size" },
  { value: "2160", label: "2160p (4K)" },
  { value: "1440", label: "1440p" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "custom", label: "Custom…" },
];

export function ExportDialog() {
  const open = useUi((s) => s.exportOpen);
  const close = () => useUi.getState().set({ exportOpen: false });
  return (
    <AppDialog open={open} onClose={close} title="Export" width={920}>
      {open && <ExportForm onDone={close} />}
    </AppDialog>
  );
}

function ExportForm({ onDone }: { onDone: () => void }) {
  const project = useProject((s) => s.project);
  const inPoint = useUi((s) => s.inPoint);
  const outPoint = useUi((s) => s.outPoint);
  const encoders = useRuntime((s) => s.encoders);
  const benchmarking = useRuntime((s) => s.benchmarking);
  const [s, setS] = useState<ExportSettings>(() => normalise({ ...defaultSettings(), ...loadLastSettings() }));
  const [presetId, setPresetId] = useState<string | null>(null);
  const [userPresets, setUserPresets] = useState<Preset[]>(loadUserPresets);
  const [copyReason, setCopyReason] = useState<string | null>("Checking…");
  const [useRange, setUseRange] = useState(inPoint != null && outPoint != null && outPoint > inPoint);
  const [customRes, setCustomRes] = useState(false);
  const [presetName, setPresetName] = useState<string | null>(null);

  const hasRange = inPoint != null && outPoint != null && outPoint > inPoint;
  const total = projectDuration(project);
  const duration = useRange && hasRange ? outPoint! - inPoint! : total;
  const audioOnly = VIDEO_CODECS_FOR[s.container].length === 0 && s.container !== "gif";
  const update = (p: Partial<ExportSettings>) => {
    setPresetId(null);
    setS((prev) => normalise({ ...prev, ...p }));
  };

  // Default output: Videos\<project>.<ext>. Follows the project name until the user picks their own path.
  const pathEdited = useRef(false);
  const lastName = useRef(project.name);
  useEffect(() => {
    if (!open) return;
    if (lastName.current !== project.name) {
      lastName.current = project.name;
      pathEdited.current = false;
    }
    if (pathEdited.current) return;
    let alive = true;
    (async () => {
      const dir = await videoDir().catch(() => "");
      const name = (project.name || "Untitled").replace(/[\\/:*?"<>|]/g, "_");
      const path = dir ? await join(dir, `${name}.${EXT_FOR[s.container]}`) : `${name}.${EXT_FOR[s.container]}`;
      if (alive) setS((prev) => (prev.outputPath === path ? prev : { ...prev, outputPath: path }));
    })();
    return () => {
      alive = false;
    };
  }, [open, project.name, s.container]);

  // Keep the extension in sync with the container.
  useEffect(() => {
    setS((prev) =>
      prev.outputPath ? { ...prev, outputPath: prev.outputPath.replace(/\.[^.\\/]+$/, "") + "." + EXT_FOR[prev.container] } : prev,
    );
  }, [s.container]);

  const finalSettings = useMemo<ExportSettings>(
    () => ({ ...s, rangeStart: useRange && hasRange ? inPoint! : 0, rangeEnd: useRange && hasRange ? outPoint! : 0 }),
    [s, useRange, hasRange, inPoint, outPoint],
  );

  useEffect(() => {
    let alive = true;
    ipc
      .checkCopyEligible(getProject(), { ...finalSettings, mode: "copy" })
      .then(() => alive && setCopyReason(null))
      .catch((e) => alive && setCopyReason(String(e)));
    return () => {
      alive = false;
    };
  }, [finalSettings, project]);

  useEffect(() => {
    if (s.mode === "copy" && copyReason) update({ mode: "render" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyReason]);

  const applyPreset = (p: Preset) => {
    setPresetId(p.id);
    setCustomRes(false);
    setS((prev) => normalise({ ...prev, encoder: "auto", fps: 0, width: 0, height: 0, ...p.settings }));
  };

  const codecEncoders = (encoders?.results ?? []).filter((r) => r.codec === s.videoCodec && r.ok);
  const bestEncoder = encoders?.best[s.videoCodec];
  const hwEncoder = codecEncoders.filter((r) => r.hardware).sort((a, b) => b.fps - a.fps)[0];
  const swEncoder = codecEncoders.filter((r) => !r.hardware).sort((a, b) => b.fps - a.fps)[0];
  const effectiveEncoder =
    s.encoder !== "auto"
      ? s.encoder
      : s.mode === "turbo"
        ? (hwEncoder ?? swEncoder)?.encoder ?? bestEncoder ?? "software"
        : (swEncoder ?? hwEncoder)?.encoder ?? bestEncoder ?? "software";
  const fastestText =
    audioOnly || s.container === "gif"
      ? "Single pass"
      : s.videoCodec === "vp9"
        ? "Parallel chunks on all CPU cores"
        : hwEncoder
          ? `GPU encoder (${hwEncoder.encoder}) · measured fastest here`
          : "Fastest CPU encoder";

  const estSize = (() => {
    const audioK = s.audioCodec === "none" ? 0 : s.audioCodec === "pcm" ? 1536 : s.audioBitrateKbps;
    if (audioOnly) return (audioK * 1000 * duration) / 8;
    if (s.qualityMode === "size") return s.targetSizeMb * 1024 * 1024;
    if (s.qualityMode === "bitrate") return ((s.bitrateKbps + audioK) * 1000 * duration) / 8;
    return null;
  })();

  const browse = async () => {
    const path = await save({
      title: "Export as",
      defaultPath: s.outputPath,
      filters: [{ name: s.container.toUpperCase(), extensions: [EXT_FOR[s.container]] }],
    });
    if (path) {
      pathEdited.current = true;
      setS((prev) => ({ ...prev, outputPath: path }));
    }
  };

  const go = async () => {
    if (!s.outputPath) return browse();
    saveLastSettings(s);
    await startExport(getProject(), finalSettings, duration);
    onDone();
  };

  const savePreset = () => {
    const name = (presetName ?? "").trim();
    if (!name) return;
    const settings: Partial<ExportSettings> = { ...s };
    delete settings.outputPath;
    delete settings.rangeStart;
    delete settings.rangeEnd;
    const next = [...userPresets, { id: uid("p_"), name, description: "Saved preset", settings, custom: true }];
    setUserPresets(next);
    saveUserPresets(next);
    setPresetName(null);
  };

  const heightValue = customRes ? "custom" : s.width && s.height ? "custom" : String(s.height);

  return (
    <div className="flex min-h-[560px]">
      {/* Presets */}
      <div className="w-60 shrink-0 border-r border-line bg-panel-2/40 p-2">
        <div className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">Presets</div>
        <div className="flex flex-col gap-0.5">
          {[...BUILTIN_PRESETS, ...userPresets].map((p) => (
            <div key={p.id} className="group relative">
              <Button
                variant="ghost"
                onClick={() => applyPreset(p)}
                className={clsx(
                  "h-auto w-full flex-col items-stretch gap-0 px-2.5 py-1.5 text-left font-normal whitespace-normal",
                  presetId === p.id && "bg-primary/12 ring-1 ring-primary/50",
                )}
              >
                <div className={clsx("text-[13px]", presetId === p.id ? "text-primary" : "text-foreground")}>{p.name}</div>
                <div className="text-[11px] text-faint">{p.description}</div>
              </Button>
              {p.custom && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete preset ${p.name}`}
                  onClick={() => {
                    const next = userPresets.filter((x) => x.id !== p.id);
                    setUserPresets(next);
                    saveUserPresets(next);
                  }}
                  className="absolute top-1.5 right-1.5 hidden text-faint group-hover:flex hover:text-destructive"
                >
                  <Trash2 size={12} />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Settings */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-5 p-5">
          <Field label="Save to">
            <div className="flex gap-2">
              <Input
                aria-label="Output file"
                value={s.outputPath}
                onChange={(e) => {
                  pathEdited.current = true;
                  setS((p) => ({ ...p, outputPath: e.target.value }));
                }}
                className="h-9 min-w-0 flex-1 rounded-[10px] bg-card font-mono text-xs"
              />
              <Button variant="outline" onClick={browse}>
                <FolderOpen size={14} /> Browse
              </Button>
            </div>
          </Field>

          <Field label="Export engine">
            <div className="grid grid-cols-3 gap-2">
              <ModeCard
                active={s.mode === "turbo"}
                icon={<Zap size={15} />}
                title="Fastest"
                text={fastestText}
                onClick={() => update({ mode: "turbo", encoder: "auto" })}
              />
              <ModeCard
                active={s.mode === "render"}
                disabled={audioOnly}
                icon={<Cpu size={15} />}
                title="Best compression"
                text="CPU encoder · smaller files at the same quality"
                onClick={() => update({ mode: "render" })}
              />
              <ModeCard
                active={s.mode === "copy"}
                disabled={!!copyReason}
                icon={<Copy size={15} />}
                title="Lossless copy"
                text={copyReason ? copyReason : "No re-encode · seconds · cuts snap to keyframes"}
                onClick={() => update({ mode: "copy" })}
              />
            </div>
          </Field>

          {s.mode !== "copy" && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Format">
                  <Select label="Format" value={s.container} options={CONTAINERS} onChange={(v) => update({ container: v })} />
                </Field>
                {!audioOnly && s.container !== "gif" && (
                  <>
                    <Field label="Video codec">
                      <Select
                        label="Video codec"
                        value={s.videoCodec}
                        options={VIDEO_CODECS_FOR[s.container].map((c) => ({ value: c, label: CODEC_LABEL[c] }))}
                        onChange={(v) => update({ videoCodec: v, encoder: "auto" })}
                      />
                    </Field>
                    <Field
                      label="Encoder"
                      hint={benchmarking ? "benchmarking…" : encoders ? "measured on this PC" : undefined}
                    >
                      {s.mode === "turbo" ? (
                        <div className="flex h-8 items-center rounded-md border border-line bg-panel-2/50 px-2 text-muted-foreground">
                          {effectiveEncoder}
                        </div>
                      ) : (
                      <Select
                        label="Encoder"
                        value={s.encoder}
                        options={[
                          { value: "auto", label: `Auto (${swEncoder?.encoder ?? bestEncoder ?? "…"})` },
                          ...codecEncoders
                            .sort((a, b) => b.fps - a.fps)
                            .map((r) => ({
                              value: r.encoder,
                              label: `${r.encoder}${r.hardware ? " · GPU" : " · CPU"} · ${Math.round(r.fps)} fps`,
                            })),
                        ]}
                        onChange={(v) => update({ encoder: v })}
                      />
                      )}
                    </Field>
                  </>
                )}
              </div>

              {!audioOnly && (
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Resolution">
                    <Select
                      label="Resolution"
                      value={heightValue}
                      options={
                        s.container === "gif"
                          ? [{ value: "0", label: "480px wide" }, ...HEIGHTS.slice(3)]
                          : HEIGHTS
                      }
                      onChange={(v) => {
                        if (v === "custom") {
                          setCustomRes(true);
                          update({ width: s.width || project.width, height: s.height || project.height });
                        } else {
                          setCustomRes(false);
                          update({ width: 0, height: Number(v) });
                        }
                      }}
                    />
                  </Field>
                  {heightValue === "custom" ? (
                    <Field label="Width × height">
                      <div className="flex items-center gap-1">
                        <NumberInput label="Width" value={s.width} min={16} step={2} onChange={(v) => update({ width: Math.round(v) })} />
                        <span className="text-muted-foreground">×</span>
                        <NumberInput label="Height" value={s.height} min={16} step={2} onChange={(v) => update({ height: Math.round(v) })} />
                      </div>
                    </Field>
                  ) : (
                    <Field label="Frame rate">
                      <Select
                        label="Frame rate"
                        value={String(s.fps)}
                        options={[
                          { value: "0", label: `Project (${project.fps})` },
                          ...[24, 25, 30, 50, 60].map((f) => ({ value: String(f), label: `${f} fps` })),
                        ]}
                        onChange={(v) => update({ fps: Number(v) })}
                      />
                    </Field>
                  )}
                  {s.container !== "gif" && (
                    <Field label="Encoding speed">
                      <Segmented
                        value={s.speedPreset}
                        onChange={(v) => update({ speedPreset: v })}
                        options={[
                          { value: "fastest", label: "Fastest" },
                          { value: "balanced", label: "Balanced" },
                          { value: "quality", label: "Best" },
                        ]}
                      />
                    </Field>
                  )}
                </div>
              )}

              {!audioOnly && s.container !== "gif" && (
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Size control">
                    <Segmented
                      value={s.qualityMode}
                      onChange={(v) => update({ qualityMode: v })}
                      options={[
                        { value: "crf", label: "Quality" },
                        { value: "bitrate", label: "Bitrate" },
                        { value: "size", label: "File size" },
                      ]}
                    />
                  </Field>
                  {s.qualityMode === "crf" && (
                    <Field label="Quality">
                      <Segmented<Quality>
                        value={s.quality}
                        onChange={(v) => update({ quality: v })}
                        options={[
                          { value: "high", label: "High" },
                          { value: "medium", label: "Medium" },
                          { value: "small", label: "Small" },
                        ]}
                      />
                    </Field>
                  )}
                  {s.qualityMode === "bitrate" && (
                    <Field label="Video bitrate">
                      <NumberInput label="Video bitrate" value={s.bitrateKbps} min={100} step={500} suffix="kbps" onChange={(v) => update({ bitrateKbps: v })} />
                    </Field>
                  )}
                  {s.qualityMode === "size" && (
                    <Field label="Target file size">
                      <NumberInput label="Target size" value={s.targetSizeMb} min={1} step={5} suffix="MB" onChange={(v) => update({ targetSizeMb: v })} />
                    </Field>
                  )}
                </div>
              )}

              {s.container !== "gif" && (
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Audio">
                    <Select
                      label="Audio codec"
                      value={s.audioCodec}
                      options={AUDIO_CODECS_FOR[s.container].map((c) => ({ value: c, label: AUDIO_LABEL[c] }))}
                      onChange={(v) => update({ audioCodec: v })}
                    />
                  </Field>
                  {s.audioCodec !== "none" && s.audioCodec !== "pcm" && (
                    <Field label="Audio bitrate">
                      <Select
                        label="Audio bitrate"
                        value={String(s.audioBitrateKbps)}
                        options={[96, 128, 160, 192, 256, 320].map((b) => ({ value: String(b), label: `${b} kbps` }))}
                        onChange={(v) => update({ audioBitrateKbps: Number(v) })}
                      />
                    </Field>
                  )}
                </div>
              )}

            </>
          )}

          <Field label="Range">
            <Segmented
              value={useRange && hasRange ? "range" : "all"}
              onChange={(v) => setUseRange(v === "range")}
              className="w-72"
              options={[
                { value: "all", label: "Whole timeline" },
                { value: "range", label: "In → Out", disabled: !hasRange, title: hasRange ? undefined : "Mark In (I) and Out (O) first" },
              ]}
            />
          </Field>
        </div>

        <div className="flex items-center gap-4 border-t border-line bg-panel-2/40 px-5 py-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Gauge size={13} /> {shortDuration(duration, true)}
          </span>
          {s.mode !== "copy" && !audioOnly && s.container !== "gif" && (
            <span className="flex items-center gap-1.5">
              <Sparkles size={13} /> {effectiveEncoder}
            </span>
          )}
          {estSize != null && <span>≈ {formatBytes(estSize)}</span>}
          <div className="ml-auto flex gap-2">
            {presetName == null ? (
              <Button variant="ghost" onClick={() => setPresetName("")}>
                <Save size={14} /> Save preset
              </Button>
            ) : (
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  savePreset();
                }}
              >
                <Input
                  autoFocus
                  aria-label="Preset name"
                  placeholder="Preset name"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setPresetName(null))}
                  className="h-8 w-40 text-xs"
                />
                <Button variant="outline" type="submit" disabled={!presetName.trim()}>
                  Save
                </Button>
              </form>
            )}
            <Button onClick={go} disabled={total <= 0} className="px-5">
              Export
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  disabled,
  icon,
  title,
  text,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      title={text}
      className={clsx(
        "h-auto flex-col items-start gap-1 p-3 text-left font-normal whitespace-normal",
        active && "border-primary bg-primary/8",
      )}
    >
      <span className={clsx("flex items-center gap-1.5 text-[13px] font-semibold", active ? "text-primary" : "text-foreground")}>
        {icon}
        {title}
      </span>
      <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{text}</span>
    </Button>
  );
}
