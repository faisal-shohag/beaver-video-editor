/** Round a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

/** HH:MM:SS:FF timecode. */
export function timecode(t: number, fps: number): string {
  const safe = Math.max(0, t);
  const fr = Math.round(fps) || 30;
  const totalFrames = Math.round(safe * fps);
  const f = totalFrames % fr;
  const s = Math.floor(totalFrames / fr);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(f)}`;
}

/** Compact duration: 1:05, 12:03:09, 0:04.5 */
export function shortDuration(t: number, withTenths = false): string {
  const safe = Math.max(0, t);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const sec = withTenths ? s.toFixed(1).padStart(4, "0") : pad(Math.floor(s));
  return h > 0 ? `${h}:${pad(m)}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
