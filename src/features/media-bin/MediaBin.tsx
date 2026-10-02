import { appendSelectedMedia, importDialog } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { IconButton, PanelHeader } from "@/components/editor";
import { timelineDrop } from "@/features/timeline/Timeline";
import { formatBytes, shortDuration } from "@/lib/time";
import type { MediaItem } from "@/lib/types";
import { useProject } from "@/store/project";
import { useRuntime } from "@/store/runtime";
import { ui, useUi } from "@/store/ui";
import clsx from "clsx";
import { AudioLines, Film, FolderInput, ListPlus, Trash2, Zap } from "lucide-react";

export function MediaBin() {
  const media = useProject((s) => s.project.media);
  const selected = useUi((s) => s.selectedMedia);

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Media">
      <PanelHeader
        icon={<Film size={14} />}
        title="Media"
        actions={
          <>
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
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {media.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-xs leading-relaxed text-muted-foreground">Import video and audio files, or drag them in from Explorer.</p>
            <Button onClick={() => importDialog(true)}>
              <FolderInput size={14} /> Import files
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-3 gap-y-3">
            {media.map((m) => (
              <MediaCard key={m.id} media={m} selected={selected.includes(m.id)} />
            ))}
          </div>
        )}
      </div>
      {media.length > 0 && (
        <p className="shrink-0 px-4 pb-3 text-[11px] leading-snug text-faint">
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
      className="group relative"
      title={`${media.name}\n${media.hasVideo ? `${media.width}×${media.height} · ${media.fps.toFixed(2)} fps · ${media.vcodec}` : media.acodec}\n${formatBytes(media.sizeBytes)}`}
    >
      <div
        className={clsx(
          "relative aspect-video overflow-hidden rounded-[10px] bg-black ring-2 transition-shadow",
          selected ? "ring-primary" : "ring-transparent group-hover:ring-line-strong",
        )}
      >
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
            {media.hasVideo ? <Spinner className="size-[18px] text-faint" /> : <AudioLines size={26} />}
          </div>
        )}
        <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
          {shortDuration(media.duration)}
        </span>
        {proxy === "pending" && (
          <span className="absolute top-1 left-1 flex items-center gap-1 rounded bg-black/70 px-1 text-[10px] text-warn" title="Building a light preview copy for smooth playback">
            <Spinner className="size-2.5" /> proxy
          </span>
        )}
        {proxy === "ready" && (
          <span className="absolute top-1 left-1 flex items-center gap-0.5 rounded bg-black/70 px-1 text-[10px] text-ok" title="Smooth-preview proxy in use (export uses the original)">
            <Zap size={9} /> proxy
          </span>
        )}
        {!used && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Remove from project"
            title="Remove from project"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => patch((d) => void (d.media = d.media.filter((x) => x.id !== media.id)))}
            className="absolute top-1 right-1 hidden size-5 bg-black/70 text-white/80 group-hover:flex hover:bg-black/80 hover:text-destructive"
          >
            <Trash2 size={11} />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1 px-0.5 pt-1.5">
        <span className="truncate text-[11px] text-muted-foreground">{media.name}</span>
      </div>
    </div>
  );
}
