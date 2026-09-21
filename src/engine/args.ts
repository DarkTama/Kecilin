// TS port of src-tauri/src/commands.rs build_ffmpeg_args — used only by the
// web (ffmpeg.wasm) engine. Keep byte-for-byte in sync with the Rust builder;
// args.test.ts mirrors the Rust unit tests to hold the line.
import type { AudioOpt, AudioSource, PresetSpec, SpeedRange, Trim } from "../store";

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

/**
 * Builds chain of FFmpeg atempo filters (each limited to [0.5, 2.0]).
 */
export function buildAtempoChain(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) {
    return "atempo=1.0";
  }
  if (speed <= 2.0) {
    return `atempo=${speed}`;
  }
  const factors: string[] = [];
  let rem = speed;
  while (rem > 2.0) {
    factors.push("atempo=2.0");
    rem /= 2.0;
  }
  factors.push(`atempo=${Number(rem.toFixed(4))}`);
  return factors.join(",");
}

/** A speed range only does something when it is finite, faster than 1x and non-empty. */
function isUsefulSpeedRange(r: SpeedRange): boolean {
  return Number.isFinite(r.speed) && r.speed > 1.0 && r.end > r.start + 0.05;
}

/**
 * Clamps speed ranges into the trim, drops the ones that do nothing, sorts
 * them and removes overlaps by pushing each range's start to the end of the
 * previous one.
 *
 * Everything downstream — duration maths, filtergraph, UI strip — assumes the
 * result: ascending, non-overlapping and inside the trim.
 */
export function normalizeSpeedRanges(
  ranges: readonly SpeedRange[] | null | undefined,
  trim: { start: number; end: number } | null,
  totalDuration?: number,
): SpeedRange[] {
  if (!ranges || ranges.length === 0) return [];
  const tStart = trim?.start ?? 0;
  const tEnd = trim?.end ?? totalDuration;

  const clamped = ranges
    .filter(isUsefulSpeedRange)
    .map((r) => {
      const start =
        tEnd !== undefined ? Math.max(tStart, Math.min(tEnd, r.start)) : Math.max(tStart, r.start);
      const end =
        tEnd !== undefined ? Math.max(start, Math.min(tEnd, r.end)) : Math.max(start, r.end);
      return { ...r, start, end };
    })
    .sort((a, b) => a.start - b.start);

  const out: SpeedRange[] = [];
  for (const r of clamped) {
    const prevEnd = out.length > 0 ? out[out.length - 1].end : -Infinity;
    const start = Math.max(r.start, prevEnd);
    if (r.end > start + 0.05) out.push({ ...r, start, end: r.end });
  }
  return out;
}

/** Accepts either the legacy single range or the list, and normalizes both. */
export function resolveSpeedRanges(
  speedRange: SpeedRange | null | undefined,
  speedRanges: readonly SpeedRange[] | null | undefined,
  trim: { start: number; end: number } | null,
  totalDuration?: number,
): SpeedRange[] {
  const source =
    speedRanges && speedRanges.length > 0 ? speedRanges : speedRange ? [speedRange] : [];
  return normalizeSpeedRanges(source, trim, totalDuration);
}

/**
 * Calculates effective playback duration taking sub-range speedup into account.
 *
 * Accepts a single range or a list; the list form is normalized first, so
 * overlapping or out-of-trim input cannot double-count.
 */
export function calculateEffectiveDuration(
  totalDuration: number,
  trim: { start: number; end: number } | null,
  speedRange: SpeedRange | readonly SpeedRange[] | null,
): number {
  const tStart = trim?.start ?? 0;
  const tEnd = trim?.end ?? totalDuration;
  const trimmed = tEnd - tStart;
  const ranges = normalizeSpeedRanges(
    speedRange == null ? [] : Array.isArray(speedRange) ? speedRange : [speedRange as SpeedRange],
    trim,
    totalDuration,
  );
  if (ranges.length === 0) return trimmed;
  // Each range shortens the output by the time it saves; the untouched parts
  // are carried by `trimmed`.
  let saved = 0;
  for (const r of ranges) {
    const len = r.end - r.start;
    saved += len - len / r.speed;
  }
  return trimmed - saved;
}

/**
 * Solves required speed multiplier S so accelerated sub-range fits targetDuration.
 * Clamps result to [1.05, 30.0].
 */
export function solveSpeedMultiplier(
  targetDuration: number,
  totalDuration: number,
  trim: { start: number; end: number } | null,
  speedRangeStart: number,
  speedRangeEnd: number,
): number {
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    return 1.0;
  }
  const tStart = trim?.start ?? 0;
  const tEnd = trim?.end ?? totalDuration;
  const sStart = Math.max(tStart, Math.min(tEnd, speedRangeStart));
  const sEnd = Math.max(sStart, Math.min(tEnd, speedRangeEnd));
  const tFixed = (sStart - tStart) + (tEnd - sEnd);
  let delta = targetDuration - tFixed;
  if (delta <= 0.05) {
    delta = 0.05;
  }
  const s = (sEnd - sStart) / delta;
  return Math.max(1.05, Math.min(30.0, s));
}

/**
 * Builds a single-pass complex filtergraph for sub-range speed acceleration.
 *
 * With N speed ranges the graph is 2N+1 segments at most: a normal segment for
 * every gap between ranges (plus the head and tail), and a sped segment per
 * range. Empty gaps are skipped, so a single range flush with both trim edges
 * still yields exactly one segment.
 */
export function buildSpeedFiltergraph(options: {
  trim: Trim | null;
  /** @deprecated pass `speedRanges` instead. */
  speedRange?: SpeedRange;
  speedRanges?: readonly SpeedRange[];
  height: number;
  hasAudio: boolean;
  audio: AudioOpt;
  normalize: boolean;
  duration?: number;
}): { filterComplex: string; mapArgs: string[] } {
  const { trim, height, normalize, duration } = options;
  const hasAudio = options.hasAudio && options.audio !== "mute";

  const tStart = trim?.start ?? 0;
  const tEnd = trim?.end ?? duration;

  const ranges = resolveSpeedRanges(
    options.speedRange ?? null,
    options.speedRanges ?? null,
    trim ? { start: trim.start, end: trim.end } : null,
    duration,
  );

  const chains: string[] = [];
  const segLabels: { v: string; a?: string }[] = [];

  const fmt = (n: number): string => Number(n.toFixed(4)).toString();

  /** Emits one normal segment; `to === undefined` means "to the end of input". */
  function pushNormal(from: number, to: number | undefined) {
    // Skip a gap too short to be worth a segment (also what keeps a range
    // flush with a trim edge from emitting an empty chunk).
    if (to !== undefined && to < from + 0.001) return;
    const idx = segLabels.length;
    const vLabel = `v${idx}`;
    const vRange = to !== undefined ? `start=${fmt(from)}:end=${fmt(to)}` : `start=${fmt(from)}`;
    chains.push(`[0:v]trim=${vRange},setpts=PTS-STARTPTS[${vLabel}]`);
    if (hasAudio) {
      const aLabel = `a${idx}`;
      chains.push(`[0:a]atrim=${vRange},asetpts=PTS-STARTPTS[${aLabel}]`);
      segLabels.push({ v: vLabel, a: aLabel });
    } else {
      segLabels.push({ v: vLabel });
    }
  }

  /** Emits one sped segment. */
  function pushSped(from: number, to: number, speed: number) {
    const idx = segLabels.length;
    const vLabel = `v${idx}`;
    chains.push(
      `[0:v]trim=start=${fmt(from)}:end=${fmt(to)},setpts=PTS-STARTPTS,setpts=PTS/${fmt(speed)}[${vLabel}]`,
    );
    if (hasAudio) {
      const aLabel = `a${idx}`;
      const atempoChain = buildAtempoChain(speed);
      chains.push(
        `[0:a]atrim=start=${fmt(from)}:end=${fmt(to)},asetpts=PTS-STARTPTS,${atempoChain}[${aLabel}]`,
      );
      segLabels.push({ v: vLabel, a: aLabel });
    } else {
      segLabels.push({ v: vLabel });
    }
  }

  let cursor = tStart;
  for (const r of ranges) {
    pushNormal(cursor, r.start);
    pushSped(r.start, r.end, r.speed);
    cursor = r.end;
  }
  // Tail: bounded by the trim end, or open-ended when the duration is unknown.
  pushNormal(cursor, tEnd);

  // Concat stitch
  const count = segLabels.length;
  let concatInputs = "";
  for (const seg of segLabels) {
    concatInputs += `[${seg.v}]`;
    if (hasAudio && seg.a) {
      concatInputs += `[${seg.a}]`;
    }
  }

  const concatFilter = `${concatInputs}concat=n=${count}:v=1:a=${hasAudio ? 1 : 0}[vcat]${hasAudio ? "[acat]" : ""}`;
  chains.push(concatFilter);

  // Video scale
  chains.push(`[vcat]scale=-2:${height}:flags=lanczos[vout]`);

  // Audio normalization / volume
  let audioOutLabel = "[acat]";
  if (hasAudio) {
    const audioFilters: string[] = [];
    if (normalize) {
      audioFilters.push(LOUDNORM);
    }
    if (options.audio === "75") audioFilters.push("volume=0.75");
    else if (options.audio === "50") audioFilters.push("volume=0.5");
    else if (options.audio === "25") audioFilters.push("volume=0.25");

    if (audioFilters.length > 0) {
      chains.push(`[acat]${audioFilters.join(",")}[aout]`);
      audioOutLabel = "[aout]";
    }
  }

  const mapArgs: string[] = ["-map", "[vout]"];
  if (hasAudio) {
    mapArgs.push("-map", audioOutLabel);
  }

  return {
    filterComplex: chains.join(";"),
    mapArgs,
  };
}

export function buildFfmpegArgs(
  input: string,
  output: string,
  preset: PresetSpec,
  trim: Trim | null,
  audio: AudioOpt,
  audioSource?: AudioSource,
  normalize?: boolean,
  extraArgs?: string[],
  speedRange?: SpeedRange | readonly SpeedRange[] | null,
  stripMetadata?: boolean,
  hasAudio?: boolean,
  duration?: number,
): string[];
export function buildFfmpegArgs(
  input: string,
  output: string,
  p: PresetSpec,
  trim: Trim | null,
  audio: AudioArgOpts,
  speed?: "slow" | "veryfast",
  encoder?: string | null,
  extra?: string[],
  speedRange?: SpeedRange | readonly SpeedRange[] | null,
  stripMetadata?: boolean,
  duration?: number,
): string[];
export function buildFfmpegArgs(
  input: string,
  output: string,
  preset: PresetSpec,
  trim: Trim | null,
  audio: AudioOpt | AudioArgOpts,
  arg6?: AudioSource | "slow" | "veryfast",
  arg7?: boolean | string | null,
  arg8?: string[],
  arg9?: SpeedRange | readonly SpeedRange[] | null,
  arg10?: boolean,
  arg11?: boolean | number,
  arg12?: number,
): string[] {
  let audioOpt: AudioOpt = "keep";
  let audioSource: AudioSource = "default";
  let normalize = false;
  let extraArgs: string[] = [];
  let speedRangeArg: SpeedRange | readonly SpeedRange[] | null = null;
  let stripMetadata = false;
  let hasAudio = true;
  let duration: number | undefined = undefined;
  let speedPreset: "slow" | "veryfast" = "slow";
  let encoder: string | null = null;
  let legacyOpts: AudioArgOpts | null = null;

  if (typeof audio === "string") {
    audioOpt = audio;
    audioSource = (arg6 as AudioSource) ?? "default";
    normalize = typeof arg7 === "boolean" ? arg7 : false;
    extraArgs = (arg8 as string[]) ?? [];
    speedRangeArg = arg9 ?? null;
    stripMetadata = typeof arg10 === "boolean" ? arg10 : false;
    hasAudio = typeof arg11 === "boolean" ? arg11 : true;
    duration = typeof arg12 === "number" ? arg12 : undefined;
  } else if (audio && typeof audio === "object") {
    legacyOpts = audio;
    speedPreset = (arg6 as "slow" | "veryfast") ?? "slow";
    encoder = (arg7 as string | null) ?? null;
    extraArgs = (arg8 as string[]) ?? [];
    speedRangeArg = arg9 ?? null;
    stripMetadata = typeof arg10 === "boolean" ? arg10 : false;
    duration = typeof arg11 === "number" ? arg11 : undefined;

    audioOpt = (audio.level ?? "keep") as AudioOpt;
    audioSource = (audio.source ?? "default") as AudioSource;
    normalize = audio.normalize;
    hasAudio = audio.level !== "mute";
  }

  const speedRanges = resolveSpeedRanges(
    Array.isArray(speedRangeArg) ? null : (speedRangeArg as SpeedRange | null),
    Array.isArray(speedRangeArg) ? (speedRangeArg as readonly SpeedRange[]) : null,
    trim ? { start: trim.start, end: trim.end } : null,
    duration,
  );
  const isSpeedActive = speedRanges.length > 0;
  const mute = legacyOpts ? legacyOpts.level === "mute" : (!hasAudio || audioOpt === "mute");

  const a: string[] = ["-y"];
  if (trim && !isSpeedActive) a.push("-ss", trim.start.toFixed(3));
  a.push("-i", input);
  if (trim && !isSpeedActive) a.push("-t", Math.max(0, trim.end - trim.start).toFixed(3));

  if (isSpeedActive) {
    const fg = buildSpeedFiltergraph({
      trim,
      speedRanges,
      height: preset.height,
      hasAudio: !mute && hasAudio,
      audio: audioOpt,
      normalize,
      duration,
    });
    a.push("-filter_complex", fg.filterComplex);
    a.push(...fg.mapArgs);
  } else {
    const merge = legacyOpts
      ? legacyOpts.source === "merge" && legacyOpts.trackCount >= 2
      : audioSource === "merge";

    const af: string[] = [];
    if (normalize) af.push(LOUDNORM);
    const audioLevel = legacyOpts ? legacyOpts.level : audioOpt;
    if (audioLevel === "75") af.push("volume=0.75");
    else if (audioLevel === "50") af.push("volume=0.5");
    else if (audioLevel === "25") af.push("volume=0.25");

    a.push("-map", "0:v:0");
    if (!mute) {
      if (merge) {
        const trackCount = legacyOpts?.trackCount ?? 2;
        const inputs = Array.from({ length: trackCount }, (_, i) => `[0:a:${i}]`).join("");
        const chain = af.length ? `,${af.join(",")}` : "";
        a.push(
          "-filter_complex",
          `${inputs}amix=inputs=${trackCount}:duration=longest:normalize=0${chain}[aout]`,
          "-map",
          "[aout]",
        );
      } else if (legacyOpts && legacyOpts.source != null && /^\d+$/.test(legacyOpts.source)) {
        a.push("-map", `0:a:${legacyOpts.source}`);
      } else if (
        typeof audioSource === "number" ||
        (typeof audioSource === "string" && /^\d+$/.test(audioSource))
      ) {
        a.push("-map", `0:a:${audioSource}`);
      } else {
        a.push("-map", "0:a?");
      }
    }
    a.push("-vf", `scale=-2:${preset.height}:flags=lanczos`);
    a.push(...videoArgs(preset, encoder, speedPreset));
    if (mute) {
      a.push("-an");
    } else {
      if (!merge && af.length) a.push("-af", af.join(","));
      a.push("-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2");
    }
    if (stripMetadata) {
      a.push("-map_metadata", "-1");
    }
    a.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", ...extraArgs, output);
    return a;
  }

  a.push(...videoArgs(preset, encoder, speedPreset));
  if (mute) {
    a.push("-an");
  } else {
    a.push("-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2");
  }
  if (stripMetadata) {
    a.push("-map_metadata", "-1");
  }
  a.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", ...extraArgs, output);
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
