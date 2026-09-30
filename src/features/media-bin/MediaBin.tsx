import { appendSelectedMedia, importDialog } from "@/app/actions";
import { Button, IconButton } from "@/components/ui";
import { timelineDrop } from "@/features/timeline/Timeline";
import { formatBytes, shortDuration } from "@/lib/time";
import type { MediaItem } from "@/lib/types";
import { useProject } from "@/store/project";
import { useRuntime } from "@/store/runtime";
import { ui, useUi } from "@/store/ui";
import clsx from "clsx";
import { AudioLines, FolderInput, ListPlus, Loader2, Trash2, Zap } from "lucide-react";

export function MediaBin() {
  const media = useProject((s) => s.project.media);
  const selected = useUi((s) => s.selectedMedia);

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Media">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Media</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Append selected to timeline (joins back to back)"
            disabled={!selected.length}
            onClick={appendSelectedMedia}
          >
            <ListPlus size={15} />
          </IconButton>
          <IconButton label="Import media (Ctrl+I)" onClick={() => importDialog(false)}>
            <FolderInput size={15} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {media.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-xs leading-relaxed text-muted">Import video and audio files, or drag them in from Explorer.</p>
            <Button variant="primary" onClick={() => importDialog(true)}>
              <FolderInput size={14} /> Import files
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {media.map((m) => (
              <MediaCard key={m.id} media={m} selected={selected.includes(m.id)} />
            ))}
          </div>
        )}
      </div>
      {media.length > 0 && (
        <p className="shrink-0 border-t border-line px-3 py-2 text-[11px] leading-snug text-faint">
          Drag onto the timeline, or double-click to append to the end.
        </p>
      )}
    </section>
  );
}

function MediaCard({ media, selected }: { media: MediaItem; selected: boolean }) {
  const thumb = useRuntime((s) => s.thumbs[media.id]);
  const proxy = useRuntime((s) => s.proxy[media.id]);
  const used = useProject((s) => s.project.clips.some((c) => c.mediaId === media.id));
  const patch = useProject((s) => s.patch);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const u = ui();
    let sel = u.selectedMedia;
    if (e.ctrlKey || e.shiftKey) sel = sel.includes(media.id) ? sel.filter((i) => i !== media.id) : [...sel, media.id];
    else if (!sel.includes(media.id)) sel = [media.id];
    u.set({ selectedMedia: sel });

    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      dragging = true;
      const ids = sel.includes(media.id) ? sel : [media.id];
      ui().set({ dragMedia: { ids, x: ev.clientX, y: ev.clientY } });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const drag = ui().dragMedia;
      ui().set({ dragMedia: null });
      if (dragging && drag) timelineDrop(drag.ids, ev.clientX, ev.clientY);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const tile = thumb?.meta;
  const idx = tile ? Math.min(tile.count - 1, Math.floor(tile.count * 0.15)) : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        ui().set({ selectedMedia: [media.id] });
        appendSelectedMedia();
      }}
      className={clsx(
        "group relative overflow-hidden rounded-lg border bg-panel-2 transition-colors",
        selected ? "border-accent" : "border-line hover:border-line-strong",
      )}
      title={`${media.name}\n${media.hasVideo ? `${media.width}×${media.height} · ${media.fps.toFixed(2)} fps · ${media.vcodec}` : media.acodec}\n${formatBytes(media.sizeBytes)}`}
    >
      <div className="relative aspect-video bg-black">
        {media.hasVideo && tile ? (
          <div
            className="absolute inset-0 bg-cover"
            style={{
              backgroundImage: `url("${thumb.img.src}")`,
              backgroundSize: `${tile.count * 100}% 100%`,
              backgroundPosition: `${(idx / Math.max(1, tile.count - 1)) * 100}% 0`,
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-audio">
            {media.hasVideo ? <Loader2 size={18} className="spin text-faint" /> : <AudioLines size={26} />}
          </div>
        )}
        <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
          {shortDuration(media.duration)}
        </span>
        {proxy === "pending" && (
          <span className="absolute top-1 left-1 flex items-center gap-1 rounded bg-black/70 px-1 text-[10px] text-accent" title="Building a light preview copy for smooth playback">
            <Loader2 size={9} className="spin" /> proxy
          </span>
        )}
        {proxy === "ready" && (
          <span className="absolute top-1 left-1 flex items-center gap-0.5 rounded bg-black/70 px-1 text-[10px] text-ok" title="Smooth-preview proxy in use (export uses the original)">
            <Zap size={9} /> proxy
          </span>
        )}
        {!used && (
          <button
            aria-label="Remove from project"
            title="Remove from project"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => patch((d) => void (d.media = d.media.filter((x) => x.id !== media.id)))}
            className="absolute top-1 right-1 hidden h-5 w-5 items-center justify-center rounded bg-black/70 text-muted group-hover:flex hover:text-danger"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <span className="truncate text-[11px] text-fg/90">{media.name}</span>
      </div>
    </div>
  );
}
