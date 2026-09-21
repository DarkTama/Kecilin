import { normalizeSpeedRanges } from "./engine/args";
import type { SpeedRange } from "./engine/types";

/**
 * Highest `HTMLMediaElement.playbackRate` Chromium will accept. The encoder
 * allows up to 30x, so anything beyond this is previewed at the cap and the
 * UI tells the user the preview is clamped.
 */
export const MAX_PREVIEW_RATE = 16;

/**
 * Above this rate the resampled audio is unintelligible, so the preview is
 * muted while the playhead sits inside the sped-up range.
 */
export const MUTE_ABOVE_RATE = 4;

/** A speed range only matters when it is enabled, valid and faster than 1x. */
function usableRange(speedRange: SpeedRange | null, enabled: boolean): SpeedRange | null {
  if (!enabled || !speedRange) return null;
  if (!Number.isFinite(speedRange.speed) || speedRange.speed <= 1.0) return null;
  if (!(speedRange.end > speedRange.start)) return null;
  return speedRange;
}

/** Accepts the single-range or the list form and keeps only the useful ones. */
function usableRanges(
  speedRange: SpeedRange | readonly SpeedRange[] | null,
  enabled: boolean,
): SpeedRange[] {
  if (!enabled || !speedRange) return [];
  const list = Array.isArray(speedRange) ? speedRange : [speedRange as SpeedRange];
  return list.filter((r): r is SpeedRange => usableRange(r, true) != null);
}

/** True when `time` sits in [start, end) of the range. */
function inRange(time: number, speedRange: SpeedRange): boolean {
  return time >= speedRange.start && time < speedRange.end;
}

/** The range covering `time`, or null when the playhead is in normal speed. */
function rangeAt(
  time: number,
  speedRange: SpeedRange | readonly SpeedRange[] | null,
  enabled: boolean,
): SpeedRange | null {
  return usableRanges(speedRange, enabled).find((r) => inRange(time, r)) ?? null;
}

/**
 * Playback rate the preview element should use at `time`.
 *
 * Returns 1 outside the speed range, the multiplier inside it, capped at
 * `MAX_PREVIEW_RATE` because browsers reject faster rates.
 */
export function resolvePlaybackRate(
  time: number,
  speedRange: SpeedRange | readonly SpeedRange[] | null,
  enabled: boolean,
): number {
  const range = rangeAt(time, speedRange, enabled);
  if (!range) return 1;
  return Math.min(range.speed, MAX_PREVIEW_RATE);
}

/**
 * True when the preview should be muted at `time`.
 *
 * Only about preview comfort — the encoder keeps the sped-up audio either way.
 */
export function shouldMutePreview(
  time: number,
  speedRange: SpeedRange | readonly SpeedRange[] | null,
  enabled: boolean,
): boolean {
  const range = rangeAt(time, speedRange, enabled);
  if (!range) return false;
  return range.speed > MUTE_ABOVE_RATE;
}

export type OutputSegment = {
  kind: "normal" | "sped";
  /** Length of this segment in the rendered output, in seconds. */
  outputDuration: number;
  /** Share of the total output duration, in [0, 1]. */
  fraction: number;
};

/**
 * Describes the rendered output as a list of consecutive segments, so the UI
 * can draw a to-scale strip of what the result will look like.
 *
 * With N speed ranges the strip alternates normal and sped segments, matching
 * the filtergraph. Mirrors `calculateEffectiveDuration`: the segment durations
 * always sum to the same effective duration the encoder will produce.
 */
export function buildOutputSegments(
  totalDuration: number,
  trim: { start: number; end: number } | null,
  speedRange: SpeedRange | readonly SpeedRange[] | null,
): OutputSegment[] {
  const tStart = trim?.start ?? 0;
  const tEnd = trim?.end ?? totalDuration;
  const trimmed = tEnd - tStart;
  if (!(trimmed > 0)) return [];

  const withFractions = (parts: Array<{ kind: OutputSegment["kind"]; outputDuration: number }>) => {
    const total = parts.reduce((acc, p) => acc + p.outputDuration, 0);
    return parts
      .filter((p) => p.outputDuration > 0)
      .map((p) => ({ ...p, fraction: total > 0 ? p.outputDuration / total : 0 }));
  };

  const ranges = normalizeSpeedRanges(
    speedRange == null ? [] : Array.isArray(speedRange) ? speedRange : [speedRange as SpeedRange],
    trim,
    totalDuration,
  );
  if (ranges.length === 0) {
    return withFractions([{ kind: "normal", outputDuration: trimmed }]);
  }

  const parts: Array<{ kind: OutputSegment["kind"]; outputDuration: number }> = [];
  let cursor = tStart;
  for (const r of ranges) {
    parts.push({ kind: "normal", outputDuration: r.start - cursor });
    parts.push({ kind: "sped", outputDuration: (r.end - r.start) / r.speed });
    cursor = r.end;
  }
  parts.push({ kind: "normal", outputDuration: tEnd - cursor });
  return withFractions(parts);
}
