import { detachAudio } from "@/app/actions";
import { Button, Field, NumberInput, Select, Slider, Switch } from "@/components/ui";
import { formatBytes, shortDuration, timecode } from "@/lib/time";
import type { Clip, Project } from "@/lib/types";
import * as ops from "@/store/ops";
import { useProject } from "@/store/project";
import { useUi } from "@/store/ui";
import { Gauge, RotateCcw, Unlink } from "lucide-react";
import type { ReactNode } from "react";

/** Slider edits preview live and land in history as one undo step. */
function liveEdit(recipe: (d: Project) => void) {
  const s = useProject.getState();
  if (!s.gestureBase) s.beginGesture();
  useProject.getState().updateGesture(recipe);
}
const commit = () => useProject.getState().endGesture(true);

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];

export function Inspector() {
  const selection = useUi((s) => s.selection);
  const project = useProject((s) => s.project);
  const clips = project.clips.filter((c) => selection.includes(c.id));

  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel" aria-label="Inspector">
      <div className="flex h-10 shrink-0 items-center border-b border-line px-3">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
          {clips.length === 0 ? "Project" : clips.length === 1 ? "Clip" : `${clips.length} clips`}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {clips.length === 0 ? <ProjectPanel project={project} /> : <ClipPanel clips={clips} project={project} />}
      </div>
    </aside>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-b border-line px-3 py-3">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</h3>
        {action}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function ClipPanel({ clips, project }: { clips: Clip[]; project: Project }) {
  const ids = clips.map((c) => c.id);
  const c = clips[0];
  const media = project.media.find((m) => m.id === c.mediaId);
  const track = project.tracks.find((t) => t.id === c.trackId);
  const isVideo = track?.kind === "video";
  const allVideo = clips.every((x) => project.tracks.find((t) => t.id === x.trackId)?.kind === "video");
  const edit = useProject((s) => s.edit);
  const speedLog = Math.log2(c.speed);

  return (
    <>
      {clips.length === 1 && media && (
        <Section title="Source">
          <div className="truncate text-sm font-medium" title={media.path}>
            {media.name}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">In / Out</dt>
            <dd className="font-mono text-fg/90">
              {timecode(c.in, project.fps)} – {timecode(c.out, project.fps)}
            </dd>
            <dt className="text-muted">On timeline</dt>
            <dd className="font-mono text-fg/90">{shortDuration(ops.clipDuration(c), true)}</dd>
            {media.hasVideo && (
              <>
                <dt className="text-muted">Video</dt>
                <dd className="text-fg/90">
                  {media.width}×{media.height} · {media.fps.toFixed(2)} fps · {media.vcodec}
                </dd>
              </>
            )}
            {media.hasAudio && (
              <>
                <dt className="text-muted">Audio</dt>
                <dd className="text-fg/90">
                  {media.acodec} · {(media.sampleRate / 1000).toFixed(1)} kHz
                </dd>
              </>
            )}
            <dt className="text-muted">File</dt>
            <dd className="text-fg/90">{formatBytes(media.sizeBytes)}</dd>
          </dl>
        </Section>
      )}

      <Section
        title="Speed"
        action={
          <span className="flex items-center gap-1 font-mono text-xs text-accent">
            <Gauge size={12} /> {c.speed.toFixed(2)}×
          </span>
        }
      >
        <Slider
          label="Speed"
          min={Math.log2(0.1)}
          max={4}
          step={0.01}
          value={speedLog}
          onChange={(v) => {
            // Snap to 1× near the centre for easy reset.
            const s = Math.abs(v) < 0.04 ? 1 : Math.round(2 ** v * 100) / 100;
            liveEdit((d) => ops.setSpeed(d, ids, s));
          }}
          onCommit={commit}
        />
        <div className="grid grid-cols-4 gap-1">
          {SPEED_PRESETS.map((s) => (
            <button
              key={s}
              onClick={() => edit((d) => ops.setSpeed(d, ids, s))}
              className={
                Math.abs(c.speed - s) < 1e-6
                  ? "rounded-md bg-accent/15 py-1 text-xs font-medium text-accent"
                  : "rounded-md bg-panel-2 py-1 text-xs text-fg/80 hover:bg-panel-3"
              }
            >
              {s}×
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <NumberInput
            label="Custom speed"
            className="w-24"
            value={c.speed}
            min={0.1}
            max={16}
            step={0.05}
            suffix="×"
            onChange={(v) => edit((d) => ops.setSpeed(d, ids, v))}
          />
          <span className="text-[11px] text-faint">0.1× – 16×</span>
        </div>
        <Switch
          label="Keep audio pitch"
          checked={c.preservePitch}
          onChange={(v) => edit((d) => ops.updateClips(d, ids, { preservePitch: v }))}
        />
      </Section>

      <Section title="Audio">
        <Field label="Volume" hint={`${Math.round(c.volume * 100)}%`}>
          <Slider
            label="Volume"
            min={0}
            max={2}
            step={0.01}
            value={c.volume}
            onChange={(v) => liveEdit((d) => ops.updateClips(d, ids, { volume: Math.abs(v - 1) < 0.03 ? 1 : v }))}
            onCommit={commit}
          />
        </Field>
        {clips.length === 1 && isVideo && media?.hasAudio && (
          <Button size="sm" disabled={c.audioDetached} onClick={() => detachAudio(c.id)}>
            <Unlink size={13} /> {c.audioDetached ? "Audio detached" : "Detach audio to track"}
          </Button>
        )}
      </Section>

      {allVideo && (
        <Section
          title="Transform"
          action={
            <button
              title="Reset transform"
              aria-label="Reset transform"
              onClick={() => edit((d) => ops.updateClips(d, ids, { x: 0, y: 0, scale: 1, opacity: 1 }))}
              className="rounded p-1 text-faint hover:bg-panel-3 hover:text-fg"
            >
              <RotateCcw size={12} />
            </button>
          }
        >
          <Field label="Opacity" hint={`${Math.round(c.opacity * 100)}%`}>
            <Slider
              label="Opacity"
              min={0}
              max={1}
              step={0.01}
              value={c.opacity}
              onChange={(v) => liveEdit((d) => ops.updateClips(d, ids, { opacity: v }))}
              onCommit={commit}
            />
          </Field>
          <Field label="Scale" hint={`${Math.round(c.scale * 100)}%`}>
            <Slider
              label="Scale"
              min={0.1}
              max={3}
              step={0.01}
              value={c.scale}
              onChange={(v) => liveEdit((d) => ops.updateClips(d, ids, { scale: Math.abs(v - 1) < 0.02 ? 1 : v }))}
              onCommit={commit}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Position X" hint={`${Math.round(c.x * 100)}%`}>
              <Slider
                label="Position X"
                min={-1}
                max={1}
                step={0.005}
                value={c.x}
                onChange={(v) => liveEdit((d) => ops.updateClips(d, ids, { x: Math.abs(v) < 0.015 ? 0 : v }))}
                onCommit={commit}
              />
            </Field>
            <Field label="Position Y" hint={`${Math.round(c.y * 100)}%`}>
              <Slider
                label="Position Y"
                min={-1}
                max={1}
                step={0.005}
                value={c.y}
                onChange={(v) => liveEdit((d) => ops.updateClips(d, ids, { y: Math.abs(v) < 0.015 ? 0 : v }))}
                onCommit={commit}
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ["Full", { x: 0, y: 0, scale: 1 }],
                ["PiP ↘", { x: 0.3, y: 0.3, scale: 0.33 }],
                ["PiP ↗", { x: 0.3, y: -0.3, scale: 0.33 }],
              ] as const
            ).map(([label, patch]) => (
              <button
                key={label}
                onClick={() => edit((d) => ops.updateClips(d, ids, patch))}
                className="rounded-md bg-panel-2 py-1 text-xs text-fg/80 hover:bg-panel-3"
              >
                {label}
              </button>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

const RESOLUTIONS = [
  { value: "1920x1080", label: "1080p · 16:9" },
  { value: "3840x2160", label: "4K · 16:9" },
  { value: "2560x1440", label: "1440p · 16:9" },
  { value: "1280x720", label: "720p · 16:9" },
  { value: "1080x1920", label: "Vertical 9:16 (Reels, TikTok)" },
  { value: "1080x1080", label: "Square 1:1" },
  { value: "1080x1350", label: "Portrait 4:5" },
];

function ProjectPanel({ project }: { project: Project }) {
  const edit = useProject((s) => s.edit);
  const res = `${project.width}x${project.height}`;
  const options = RESOLUTIONS.some((r) => r.value === res)
    ? RESOLUTIONS
    : [{ value: res, label: `${project.width}×${project.height} (from media)` }, ...RESOLUTIONS];
  const duration = ops.projectDuration(project);

  return (
    <>
      <Section title="Canvas">
        <Field label="Resolution">
          <Select
            label="Resolution"
            value={res}
            options={options}
            onChange={(v) => {
              const [w, h] = v.split("x").map(Number);
              edit((d) => {
                d.width = w;
                d.height = h;
              });
            }}
          />
        </Field>
        <Field label="Frame rate">
          <Select
            label="Frame rate"
            value={project.fps}
            options={[23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
              .concat([23.976, 24, 25, 29.97, 30, 50, 59.94, 60].includes(project.fps) ? [] : [project.fps])
              .map((f) => ({ value: f, label: `${f} fps` }))}
            onChange={(v) => edit((d) => void (d.fps = v))}
          />
        </Field>
        <p className="text-[11px] leading-relaxed text-faint">
          Set automatically from the first video you import. Clips with a different shape are letterboxed.
        </p>
      </Section>
      <Section title="Summary">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Duration</dt>
          <dd className="font-mono">{timecode(duration, project.fps)}</dd>
          <dt className="text-muted">Clips</dt>
          <dd>{project.clips.length}</dd>
          <dt className="text-muted">Tracks</dt>
          <dd>
            {project.tracks.filter((t) => t.kind === "video").length} video ·{" "}
            {project.tracks.filter((t) => t.kind === "audio").length} audio
          </dd>
          <dt className="text-muted">Media</dt>
          <dd>{project.media.length} files</dd>
        </dl>
      </Section>
      <Section title="Quick guide">
        <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted">
          <li>
            <b className="text-fg/90">Cut</b> — drag clip edges, or mark In (I) / Out (O) and press Shift+Del.
          </li>
          <li>
            <b className="text-fg/90">Split</b> — S at the playhead, or the blade tool (B).
          </li>
          <li>
            <b className="text-fg/90">Join</b> — drop several files on the timeline, or use Quick Join for lossless joins.
          </li>
          <li>
            <b className="text-fg/90">Speed</b> — select a clip and set 0.1×–16× here.
          </li>
        </ul>
      </Section>
    </>
  );
}
