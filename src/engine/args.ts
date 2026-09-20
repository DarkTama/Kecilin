// TS port of src-tauri/src/commands.rs build_ffmpeg_args — used only by the
// web (ffmpeg.wasm) engine. Keep byte-for-byte in sync with the Rust builder;
// args.test.ts mirrors the Rust unit tests to hold the line.
import type { PresetSpec, Trim } from "../store";

export const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

export type AudioArgOpts = {
  source: string | null; // null/"default" | "merge" | "0","1",…
  level: string | null; // null | "mute" | "75"|"50"|"25"
  normalize: boolean;
  trackCount: number;
};

/** Filesystem-safe preset name (mirrors Rust `slug`). */
export function slug(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return s || "custom";
}

function kbps(rate: string): number {
  return Number.parseInt(rate, 10) || 2000;
}

function videoArgs(p: PresetSpec, encoder: string | null, speed: "slow" | "veryfast"): string[] {
  const crf = String(p.crf);
  switch (encoder) {
    case "nvenc":
      return [
        "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr",
        "-cq", crf, "-b:v", "0", "-maxrate", p.maxrate, "-bufsize", p.bufsize,
        "-profile:v", "high", "-level", p.level, "-pix_fmt", "yuv420p",
        "-g", "120", "-bf", "3",
      ];
    case "amf":
      return [
        "-c:v", "h264_amf", "-usage", "transcoding", "-quality", "quality",
        "-rc", "vbr_peak", "-b:v", `${Math.floor((kbps(p.maxrate) * 6) / 10)}k`,
        "-maxrate", p.maxrate, "-bufsize", p.bufsize,
        "-profile:v", "high", "-level", p.level, "-pix_fmt", "yuv420p",
        "-g", "120", "-bf", "3",
      ];
    case "qsv":
      return [
        "-c:v", "h264_qsv", "-preset", "slower", "-global_quality", crf, "-look_ahead", "1",
        "-maxrate", p.maxrate, "-bufsize", p.bufsize,
        "-profile:v", "high", "-level", p.level, "-pix_fmt", "nv12",
        "-g", "120", "-bf", "3",
      ];
    default:
      return [
        "-c:v", "libx264", "-preset", speed, "-profile:v", "high",
        "-level", p.level, "-pix_fmt", "yuv420p",
        "-crf", crf, "-maxrate", p.maxrate, "-bufsize", p.bufsize,
        "-g", "120", "-keyint_min", "60", "-sc_threshold", "40",
        "-bf", "3", "-refs", "4", "-rc-lookahead", "40",
        "-x264-params", "aq-mode=3:aq-strength=0.8",
      ];
  }
}

export function buildFfmpegArgs(
  input: string,
  output: string,
  p: PresetSpec,
  trim: Trim | null,
  audio: AudioArgOpts,
  /** "slow" matches the script/desktop; the web build uses "veryfast". */
  speed: "slow" | "veryfast" = "slow",
  encoder: string | null = null,
  extra: string[] = [],
): string[] {
  const a: string[] = ["-y"];
  if (trim) a.push("-ss", trim.start.toFixed(3));
  a.push("-i", input);
  if (trim) a.push("-t", Math.max(0, trim.end - trim.start).toFixed(3));

  const mute = audio.level === "mute";
  const merge = audio.source === "merge" && audio.trackCount >= 2;

  const af: string[] = [];
  if (audio.normalize) af.push(LOUDNORM);
  if (audio.level === "75") af.push("volume=0.75");
  else if (audio.level === "50") af.push("volume=0.5");
  else if (audio.level === "25") af.push("volume=0.25");

  a.push("-map", "0:v:0");
  if (!mute) {
    if (merge) {
      const inputs = Array.from({ length: audio.trackCount }, (_, i) => `[0:a:${i}]`).join("");
      const chain = af.length ? `,${af.join(",")}` : "";
      a.push(
        "-filter_complex",
        `${inputs}amix=inputs=${audio.trackCount}:duration=longest:normalize=0${chain}[aout]`,
        "-map",
        "[aout]",
      );
    } else if (audio.source != null && /^\d+$/.test(audio.source)) {
      a.push("-map", `0:a:${audio.source}`);
    } else {
      a.push("-map", "0:a?");
    }
  }
  a.push("-vf", `scale=-2:${p.height}:flags=lanczos`);
  a.push(...videoArgs(p, encoder, speed));
  if (mute) {
    a.push("-an");
  } else {
    if (!merge && af.length) a.push("-af", af.join(","));
    a.push("-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2");
  }
  a.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", ...extra, output);
  return a;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * Replaces any character in [\\/:*?"<>|] with _.
 * Trims leading and trailing whitespace and periods.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
}

export function resolveOutputFilename(options: {
  stem: string;
  presetName: string;
  height?: number;
  part?: number | null;
  totalParts?: number;
  pattern?: string; // default: "{name}_whatsapp_{preset}{part}"
  customName?: string;
  now?: Date;
}): string {
  // Direct customName override
  if (options.customName && options.customName.trim().length > 0) {
    const sanitized = sanitizeFilename(options.customName.trim());
    if (sanitized.length > 0) {
      return /\.mp4$/i.test(sanitized) ? sanitized : `${sanitized}.mp4`;
    }
  }

  const base = options.stem.split(/[/\\]/).pop() ?? options.stem;
  const lastDot = base.lastIndexOf(".");
  const stem = lastDot > 0 ? base.slice(0, lastDot) : base;

  const rawPattern =
    options.pattern && options.pattern.trim().length > 0
      ? options.pattern
      : "{name}_whatsapp_{preset}{part}";

  const patternHadPart = /{part}/i.test(rawPattern);

  const partSuffix =
    options.part != null && options.part > 0 ? `_part${options.part}` : "";
  const resolution =
    options.height != null && options.height > 0
      ? `${options.height}p`
      : options.presetName;
  const dateStr = formatDate(options.now ?? new Date());

  const tokens: Record<string, string> = {
    "{name}": stem,
    "{stem}": stem,
    "{preset}": slug(options.presetName),
    "{part}": partSuffix,
    "{resolution}": resolution,
    "{date}": dateStr,
  };

  let resolved = rawPattern.replace(
    /{(name|stem|preset|part|resolution|date)}/gi,
    (m) => tokens[m.toLowerCase()] ?? m,
  );

  resolved = resolved.replace(/\.mp4$/i, "");
  resolved = sanitizeFilename(resolved);

  const isMultiPart =
    (options.totalParts !== undefined ? options.totalParts > 1 : true) &&
    options.part != null &&
    options.part > 0;

  if (isMultiPart && !patternHadPart && !resolved.includes(`_part${options.part}`)) {
    resolved = `${resolved}_part${options.part}`;
  }

  if (!resolved) {
    resolved = "output";
  }

  return `${resolved}.mp4`;
}

/** `{stem}_whatsapp_{preset}[_partN].mp4` — delegates to resolveOutputFilename. */
export function outputName(
  srcPath: string,
  presetName: string,
  part: number | null,
  pattern?: string,
  customName?: string,
  height?: number,
): string {
  return resolveOutputFilename({
    stem: srcPath,
    presetName,
    height,
    part,
    pattern,
    customName,
  });
}
