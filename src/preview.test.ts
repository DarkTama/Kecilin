import { describe, it, expect } from "vitest";
import {
  MAX_PREVIEW_RATE,
  MUTE_ABOVE_RATE,
  resolvePlaybackRate,
  shouldMutePreview,
  buildOutputSegments,
} from "./preview";
import { calculateEffectiveDuration } from "./engine/args";
import type { SpeedRange } from "./engine/types";

const range = (start: number, end: number, speed: number): SpeedRange => ({
  start,
  end,
  speed,
  fitTarget: false,
});

describe("resolvePlaybackRate", () => {
  it("returns 1 when the ramp is disabled", () => {
    expect(resolvePlaybackRate(5, range(0, 10, 4), false)).toBe(1);
  });

  it("returns 1 when there is no speed range", () => {
    expect(resolvePlaybackRate(5, null, true)).toBe(1);
  });

  it("returns 1 before the range starts", () => {
    expect(resolvePlaybackRate(1.99, range(2, 8, 4), true)).toBe(1);
  });

  it("returns the multiplier at the inclusive start boundary", () => {
    expect(resolvePlaybackRate(2, range(2, 8, 4), true)).toBe(4);
  });

  it("returns the multiplier inside the range", () => {
    expect(resolvePlaybackRate(5, range(2, 8, 4), true)).toBe(4);
  });

  it("returns 1 at the exclusive end boundary", () => {
    expect(resolvePlaybackRate(8, range(2, 8, 4), true)).toBe(1);
  });

  it("returns 1 after the range ends", () => {
    expect(resolvePlaybackRate(9, range(2, 8, 4), true)).toBe(1);
  });

  it("caps the rate at the browser maximum", () => {
    expect(resolvePlaybackRate(5, range(2, 8, 30), true)).toBe(MAX_PREVIEW_RATE);
  });

  it("does not cap a rate at the browser maximum exactly", () => {
    expect(resolvePlaybackRate(5, range(2, 8, MAX_PREVIEW_RATE), true)).toBe(MAX_PREVIEW_RATE);
  });

  it("never returns a rate below 1 for a slowed range", () => {
    expect(resolvePlaybackRate(5, range(2, 8, 0.5), true)).toBe(1);
  });

  it("returns 1 for a non-finite multiplier", () => {
    expect(resolvePlaybackRate(5, range(2, 8, Number.NaN), true)).toBe(1);
  });

  it("returns 1 for a degenerate range", () => {
    expect(resolvePlaybackRate(5, range(5, 5, 4), true)).toBe(1);
  });
});

describe("shouldMutePreview", () => {
  it("does not mute outside the range", () => {
    expect(shouldMutePreview(1, range(2, 8, 8), true)).toBe(false);
  });

  it("does not mute at moderate speeds inside the range", () => {
    expect(shouldMutePreview(5, range(2, 8, 2), true)).toBe(false);
  });

  it("does not mute at exactly the mute threshold", () => {
    expect(shouldMutePreview(5, range(2, 8, MUTE_ABOVE_RATE), true)).toBe(false);
  });

  it("mutes above the threshold inside the range", () => {
    expect(shouldMutePreview(5, range(2, 8, 8), true)).toBe(true);
  });

  it("does not mute when the ramp is disabled", () => {
    expect(shouldMutePreview(5, range(2, 8, 8), false)).toBe(false);
  });
  it("does not mute at the inclusive start boundary below the threshold", () => {
    expect(shouldMutePreview(2, range(2, 8, 2), true)).toBe(false);
  });

  it("mutes at the inclusive start boundary", () => {
    expect(shouldMutePreview(2, range(2, 8, 8), true)).toBe(true);
  });

  it("does not mute at the exclusive end boundary", () => {
    expect(shouldMutePreview(8, range(2, 8, 8), true)).toBe(false);
  });

  it("does not mute for a non-finite multiplier", () => {
    expect(shouldMutePreview(5, range(2, 8, Number.NaN), true)).toBe(false);
  });
});

describe("buildOutputSegments", () => {
  it("returns a single normal segment when there is no speed range", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, null);
    expect(segs).toEqual([{ kind: "normal", outputDuration: 60, fraction: 1 }]);
  });

  it("splits the trim into head, sped and tail segments", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(20, 40, 4));
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: "normal", outputDuration: 20 });
    expect(segs[1]).toMatchObject({ kind: "sped", outputDuration: 5 });
    expect(segs[2]).toMatchObject({ kind: "normal", outputDuration: 20 });
  });

  it("produces fractions that sum to one", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(20, 40, 4));
    const total = segs.reduce((acc, s) => acc + s.fraction, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("matches calculateEffectiveDuration in total output length", () => {
    const segs = buildOutputSegments(60, { start: 10, end: 50 }, range(20, 40, 4));
    const total = segs.reduce((acc, s) => acc + s.outputDuration, 0);
    expect(total).toBeCloseTo(10 + 5 + 10, 6);
  });

  it("drops an empty head segment", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(0, 40, 4));
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ kind: "sped" });
  });

  it("drops an empty tail segment", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(20, 60, 4));
    expect(segs).toHaveLength(2);
    expect(segs[1]).toMatchObject({ kind: "sped" });
  });

  it("clamps a speed range that overflows the trim", () => {
    const segs = buildOutputSegments(60, { start: 10, end: 50 }, range(0, 90, 4));
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ kind: "sped", outputDuration: 10 });
  });

  it("treats a null trim as the whole file", () => {
    const segs = buildOutputSegments(60, null, range(20, 40, 4));
    const total = segs.reduce((acc, s) => acc + s.outputDuration, 0);
    expect(total).toBeCloseTo(45, 6);
  });

  it("returns an empty list for a zero-length trim", () => {
    expect(buildOutputSegments(60, { start: 30, end: 30 }, range(20, 40, 4))).toEqual([]);
  });

  it("ignores a speed range at or below 1x", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(20, 40, 1));
    expect(segs).toEqual([{ kind: "normal", outputDuration: 60, fraction: 1 }]);
  });

  it("ignores a non-finite speed", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(20, 40, Number.NaN));
    expect(segs).toEqual([{ kind: "normal", outputDuration: 60, fraction: 1 }]);
  });

  it("ignores an infinite speed", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(20, 40, Infinity));
    expect(segs).toEqual([{ kind: "normal", outputDuration: 60, fraction: 1 }]);
  });

  it("collapses a range that lies entirely before the trim", () => {
    const segs = buildOutputSegments(60, { start: 10, end: 50 }, range(0, 5, 4));
    expect(segs).toEqual([{ kind: "normal", outputDuration: 40, fraction: 1 }]);
  });

  it("collapses a range that lies entirely after the trim", () => {
    const segs = buildOutputSegments(60, { start: 10, end: 50 }, range(55, 60, 4));
    expect(segs).toEqual([{ kind: "normal", outputDuration: 40, fraction: 1 }]);
  });

  it("produces a single fraction of one for a two-segment result", () => {
    const segs = buildOutputSegments(60, { start: 0, end: 60 }, range(0, 40, 4));
    expect(segs.reduce((acc, s) => acc + s.fraction, 0)).toBeCloseTo(1, 6);
  });

  it("clamps a range extending past the end of an untrimmed file", () => {
    const segs = buildOutputSegments(60, null, range(40, 900, 4));
    const total = segs.reduce((acc, s) => acc + s.outputDuration, 0);
    expect(total).toBeCloseTo(45, 6);
  });
});

describe("buildOutputSegments agrees with calculateEffectiveDuration", () => {
  const cases: Array<[string, number, { start: number; end: number } | null, SpeedRange | null]> = [
    ["no speed range", 60, { start: 0, end: 60 }, null],
    ["range inside the trim", 60, { start: 10, end: 50 }, range(20, 40, 4)],
    ["range flush with the trim start", 60, { start: 0, end: 60 }, range(0, 40, 4)],
    ["range flush with the trim end", 60, { start: 0, end: 60 }, range(20, 60, 4)],
    ["range overflowing both trim ends", 60, { start: 10, end: 50 }, range(0, 90, 4)],
    ["range before the trim", 60, { start: 10, end: 50 }, range(0, 5, 4)],
    ["range after the trim", 60, { start: 10, end: 50 }, range(55, 60, 4)],
    ["null trim", 60, null, range(20, 40, 4)],
    ["speed at 1x", 60, { start: 0, end: 60 }, range(20, 40, 1)],
    ["inverted range", 60, { start: 0, end: 60 }, range(40, 20, 4)],
    ["non-finite speed", 60, { start: 0, end: 60 }, range(20, 40, Number.NaN)],
    ["infinite speed", 60, { start: 0, end: 60 }, range(20, 40, Infinity)],
    ["maximum speed", 60, { start: 0, end: 60 }, range(20, 40, 30)],
  ];

  it.each(cases)("%s", (_label, total, trim, speedRange) => {
    const segs = buildOutputSegments(total, trim, speedRange);
    const summed = segs.reduce((acc, s) => acc + s.outputDuration, 0);
    expect(summed).toBeCloseTo(calculateEffectiveDuration(total, trim, speedRange), 6);
  });
});
