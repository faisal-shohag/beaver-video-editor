import { Button, Dialog, IconButton } from "@/components/ui";
import { importPaths } from "@/features/media-bin/importer";
import { startQuickJoin } from "@/features/export/jobs";
import { VIDEO_EXTENSIONS, ipc } from "@/lib/ipc";
import { shortDuration } from "@/lib/time";
import type { JoinCheck } from "@/lib/types";
import { useUi } from "@/store/ui";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, CheckCircle2, FilePlus2, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

/** Lossless joiner: same-format files are concatenated with stream copy in seconds. */
export function QuickJoin() {
  const isOpen = useUi((s) => s.joinOpen);
  const close = () => useUi.getState().set({ joinOpen: false });
  const [paths, setPaths] = useState<string[]>([]);
  const [check, setCheck] = useState<JoinCheck | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (paths.length < 2) return setCheck(null);
    let alive = true;
    setChecking(true);
    ipc
      .quickJoinCheck(paths)
      .then((c) => alive && setCheck(c))
      .catch((e) => alive && setCheck({ compatible: false, reason: String(e), totalDuration: 0, infos: [] }))
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, [paths]);

  const add = async () => {
    const picked = await open({ multiple: true, title: "Files to join", filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }] });
    if (picked) setPaths((p) => [...p, ...(Array.isArray(picked) ? picked : [picked])]);
  };

  const move = (i: number, d: number) =>
    setPaths((p) => {
      const next = [...p];
      const j = i + d;
      if (j < 0 || j >= next.length) return p;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const join = async () => {
    const first = paths[0];
    const ext = first.split(".").pop()?.toLowerCase() ?? "mp4";
    const out = await save({
      title: "Save joined video",
      defaultPath: first.replace(/\.[^.\\/]+$/, `_joined.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!out) return;
    await startQuickJoin(paths, out, check?.totalDuration ?? 0);
    setPaths([]);
    close();
  };

  const toTimeline = async () => {
    await importPaths(paths, { append: true });
    setPaths([]);
    close();
  };

  return (
    <Dialog
      open={isOpen}
      onClose={close}
      title="Quick Join"
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={toTimeline} disabled={paths.length === 0} className="mr-auto">
            Add to timeline instead
          </Button>
          <Button variant="primary" onClick={join} disabled={!check?.compatible || checking}>
            Join losslessly
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs leading-relaxed text-muted">
          Files with identical format (codec, resolution, frame rate, audio) are joined without re-encoding — no
          quality loss, done in seconds. Different formats can be joined on the timeline and exported.
        </p>
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-panel-2 p-1.5">
          {paths.length === 0 && <div className="px-2 py-6 text-center text-xs text-faint">No files yet</div>}
          {paths.map((p, i) => {
            const info = check?.infos[i];
            return (
              <div key={`${p}-${i}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-3">
                <span className="w-5 text-right font-mono text-[11px] text-faint">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{p.split(/[\\/]/).pop()}</div>
                  {info && (
                    <div className="text-[11px] text-faint">
                      {info.vcodec} · {info.width}×{info.height} · {info.fps.toFixed(2)} fps · {info.acodec || "no audio"} ·{" "}
                      {shortDuration(info.duration)}
                    </div>
                  )}
                </div>
                <IconButton label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton label="Move down" onClick={() => move(i, 1)} disabled={i === paths.length - 1}>
                  <ArrowDown size={13} />
                </IconButton>
                <IconButton label="Remove" onClick={() => setPaths((ps) => ps.filter((_, j) => j !== i))}>
                  <X size={13} />
                </IconButton>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={add}>
            <FilePlus2 size={14} /> Add files
          </Button>
          {checking && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Loader2 size={13} className="spin" /> Checking formats…
            </span>
          )}
          {!checking && check?.compatible && (
            <span className="flex items-center gap-1.5 text-xs text-ok">
              <CheckCircle2 size={14} /> Compatible · {shortDuration(check.totalDuration)} total
            </span>
          )}
          {!checking && check && !check.compatible && (
            <span className="flex min-w-0 items-start gap-1.5 text-xs text-accent">
              <TriangleAlert size={14} className="mt-px shrink-0" /> <span>{check.reason}</span>
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
}
