import { produce } from "immer";
import { describe, expect, it } from "vitest";
import type { MediaItem, Project } from "@/lib/types";
import * as ops from "./ops";

function media(id: string, duration: number, hasVideo = true): MediaItem {
  return {
    id, path: `C:/m/${id}.mp4`, name: id, duration, sizeBytes: 1, formatName: "mp4", hasVideo, hasAudio: true,
    width: 1920, height: 1080, fps: 30, vcodec: "h264", pixFmt: "yuv420p", acodec: "aac", sampleRate: 48000,
    channels: 2, rotation: 0,
  };
}

function base(): Project {
  const p = ops.createProject();
  p.media = [media("m1", 10), media("m2", 6), media("song", 30, false)];
  return p;
}

const v1 = (p: Project) => p.tracks[0].id;
const edit = (p: Project, fn: (d: Project) => void) => produce(p, fn);

describe("joiner", () => {
  it("appends clips back to back on the first matching track", () => {
    const p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0], d.media[1], d.media[2]]));
    const vids = ops.clipsOnTrack(p, v1(p));
    expect(vids.map((c) => [c.start, ops.clipEnd(c)])).toEqual([[0, 10], [10, 16]]);
    const audio = p.clips.find((c) => c.mediaId === "song")!;
    expect(ops.trackOf(p, audio.trackId)!.kind).toBe("audio");
    expect(audio.start).toBe(0);
  });
});

describe("splitter", () => {
  it("splits at time and keeps source continuity", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    p = edit(p, (d) => void ops.splitClips(d, [d.clips[0].id], 4));
    const [a, b] = ops.clipsOnTrack(p, v1(p));
    expect([a.in, a.out, b.start, b.in, b.out]).toEqual([0, 4, 4, 4, 10]);
  });

  it("maps timeline time through speed", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    p = edit(p, (d) => ops.setSpeed(d, [d.clips[0].id], 2));
    p = edit(p, (d) => void ops.splitClips(d, [d.clips[0].id], 1));
    const [a, b] = ops.clipsOnTrack(p, v1(p));
    expect(a.out).toBe(2);
    expect(b.in).toBe(2);
    expect(ops.clipEnd(b)).toBe(5);
  });

  it("ignores split points at clip edges", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    p = edit(p, (d) => void ops.splitClips(d, [d.clips[0].id], 0));
    expect(p.clips).toHaveLength(1);
  });
});

describe("cutter", () => {
  it("trims start/end within media bounds and neighbours", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0], d.media[1]]));
    const [a, b] = ops.clipsOnTrack(p, v1(p));
    p = edit(p, (d) => ops.trimEnd(d, a.id, 50)); // blocked by b at 10
    expect(ops.clipEnd(p.clips.find((c) => c.id === a.id)!)).toBe(10);
    p = edit(p, (d) => ops.trimStart(d, b.id, 12));
    const nb = p.clips.find((c) => c.id === b.id)!;
    expect([nb.start, nb.in]).toEqual([12, 2]);
    p = edit(p, (d) => ops.trimStart(d, b.id, 0)); // can't extend before media start
    expect(p.clips.find((c) => c.id === b.id)!.start).toBe(10);
  });

  it("range delete with ripple closes the gap on all tracks", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0], d.media[1], d.media[2]]));
    p = edit(p, (d) => ops.deleteRange(d, 2, 5, true));
    expect(ops.projectDuration(p)).toBe(27);
    const vids = ops.clipsOnTrack(p, v1(p));
    expect(vids.map((c) => [c.start, c.in, c.out])).toEqual([[0, 0, 2], [2, 5, 10], [7, 0, 6]]);
  });

  it("ripple delete shifts following clips on that track only", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0], d.media[1], d.media[2]]));
    const first = ops.clipsOnTrack(p, v1(p))[0];
    p = edit(p, (d) => ops.deleteClips(d, [first.id], true));
    expect(ops.clipsOnTrack(p, v1(p))[0].start).toBe(0);
    expect(p.clips.find((c) => c.mediaId === "song")!.start).toBe(0);
  });

  it("respects locked tracks", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    p = edit(p, (d) => {
      d.tracks[0].locked = true;
      ops.deleteRange(d, 1, 2, true);
    });
    expect(p.clips).toHaveLength(1);
  });
});

describe("speed", () => {
  it("slowing a clip pushes later clips instead of overlapping", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0], d.media[1]]));
    const [a, b] = ops.clipsOnTrack(p, v1(p));
    p = edit(p, (d) => ops.setSpeed(d, [a.id], 0.5));
    expect(ops.clipEnd(p.clips.find((c) => c.id === a.id)!)).toBe(20);
    expect(p.clips.find((c) => c.id === b.id)!.start).toBe(20);
  });

  it("speeding up keeps a butted neighbour joined, but leaves a real gap alone", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0], d.media[1]]));
    const [a, b] = ops.clipsOnTrack(p, v1(p));
    p = edit(p, (d) => ops.setSpeed(d, [a.id], 2));
    expect(p.clips.find((c) => c.id === b.id)!.start).toBe(5);
    p = edit(p, (d) => {
      d.clips.find((c) => c.id === b.id)!.start = 8;
      ops.setSpeed(d, [a.id], 4);
    });
    expect(p.clips.find((c) => c.id === b.id)!.start).toBe(8);
  });

  it("clamps to 0.1x..16x", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    p = edit(p, (d) => ops.setSpeed(d, [d.clips[0].id], 100));
    expect(p.clips[0].speed).toBe(16);
  });
});

describe("moving", () => {
  it("single clip dropped onto another slides to nearest free spot", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0], d.media[1]]));
    const b = ops.clipsOnTrack(p, v1(p))[1];
    p = edit(p, (d) => {
      ops.moveClips(d, [b.id], -7, 0); // lands at 3, overlapping clip a (0..10)
      expect(ops.resolveDrop(d, [b.id])).toBe(true);
    });
    // Nearest free spot is right after a (10) since before would be negative.
    expect(p.clips.find((c) => c.id === b.id)!.start).toBe(10);
  });

  it("moves between lanes of the same kind only", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    p = edit(p, (d) => ops.moveClips(d, [d.clips[0].id], 0, 5));
    expect(p.clips[0].trackId).toBe(p.tracks[1].id);
  });
});

describe("tracks", () => {
  it("detaches audio to a free audio track", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    p = edit(p, (d) => void ops.detachAudio(d, d.clips[0].id));
    expect(p.clips).toHaveLength(2);
    expect(p.clips[0].audioDetached).toBe(true);
    expect(ops.trackOf(p, p.clips[1].trackId)!.kind).toBe("audio");
  });

  it("adds video tracks above existing video tracks, before audio", () => {
    const p = edit(base(), (d) => void ops.addTrack(d, "video"));
    expect(p.tracks.map((t) => t.name)).toEqual(["V1", "V2", "V3", "A1", "A2"]);
  });

  it("snaps to nearby points", () => {
    expect(ops.nearestSnap(4.02, [0, 4, 10], 0.05)).toBe(4);
    expect(ops.nearestSnap(4.2, [0, 4, 10], 0.05)).toBeNull();
  });
});

describe("enhance", () => {
  it("sets, keeps through split, attaches rendered file, and clears", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    const id = p.clips[0].id;
    p = edit(p, (d) => ops.setEnhance(d, [id], { model: "dfn3", strength: "full", path: null }));
    p = edit(p, (d) => void ops.splitClips(d, [id], 4));
    expect(p.clips.every((c) => c.enhance?.model === "dfn3")).toBe(true);
    p = edit(p, (d) => ops.attachEnhanced(d, "C:/m/m1.mp4", "dfn3", "full", "C:/cache/x.wav"));
    expect(p.clips.every((c) => c.enhance?.path === "C:/cache/x.wav")).toBe(true);
    // Split halves must not share one mutable enhance object.
    p = edit(p, (d) => ops.setEnhance(d, [p.clips[0].id], { model: "sidon", strength: "full", path: null }));
    expect(p.clips[1].enhance?.model).toBe("dfn3");
    p = edit(p, (d) => ops.setEnhance(d, [p.clips[1].id], null));
    expect(p.clips[1].enhance).toBeNull();
  });

  it("changing strength resets the rendered path", () => {
    let p = edit(base(), (d) => void ops.appendMedia(d, [d.media[0]]));
    const id = p.clips[0].id;
    p = edit(p, (d) => ops.setEnhance(d, [id], { model: "dfn3", strength: "full", path: "C:/cache/a.wav" }));
    p = edit(p, (d) => ops.setEnhance(d, [id], { model: "dfn3", strength: "light", path: null }));
    expect(p.clips[0].enhance?.path).toBeNull();
  });
});
