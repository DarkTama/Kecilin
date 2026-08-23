export function fmtSize(bytes: number): string {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + " GB";
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

/** Seconds → "m:ss.t" (tenths are enough for trim UI). */
export function fmtTime(secs: number): string {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

/** "m:ss", "h:mm:ss", or plain seconds → seconds. Null if unparseable. */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.some((p) => p.trim() === "" || Number.isNaN(Number(p)))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + Number(p);
  return secs >= 0 ? secs : null;
}
