import { describe, it, expect, vi } from "vitest";
import { computePeaks, generateWaveformData } from "./waveform";

describe("computePeaks", () => {
  it("returns zero peaks for silent PCM data", () => {
    const silent = new Float32Array(1000).fill(0);
    const peaks = computePeaks(silent, 10);
    expect(peaks.length).toBe(10);
    peaks.forEach((p) => expect(p).toBe(0));
  });

  it("detects peak amplitudes correctly across buckets", () => {
    const data = new Float32Array(100);
    // Put a spike in the first half
    data[10] = 0.8;
    data[11] = -0.9;
    const peaks = computePeaks(data, 2);
    expect(peaks[0]).toBeCloseTo(0.9, 2);
    expect(peaks[1]).toBe(0);
  });

  it("handles empty PCM data", () => {
    const empty = new Float32Array(0);
    const peaks = computePeaks(empty, 5);
    expect(peaks.length).toBe(5);
    peaks.forEach((p) => expect(p).toBe(0));
  });

  it("handles 0 or negative numBuckets", () => {
    const data = new Float32Array([0.1, 0.5, -0.8]);
    expect(computePeaks(data, 0).length).toBe(0);
    expect(computePeaks(data, -5).length).toBe(0);
  });

  it("handles NaN and Infinity in PCM data", () => {
    const data = new Float32Array([NaN, 0.5, Infinity, -Infinity, -0.7]);
    const peaks = computePeaks(data, 1);
    expect(peaks.length).toBe(1);
    expect(peaks[0]).toBeCloseTo(0.7, 2);
  });
});

describe("generateWaveformData", () => {
  it("fetches audio buffer and generates peaks", async () => {
    const mockChannelData = new Float32Array([0.1, 0.4, 0.8, 0.2]);
    const mockDecodeAudioData = vi.fn().mockResolvedValue({
      getChannelData: vi.fn().mockReturnValue(mockChannelData),
    });
    const mockClose = vi.fn().mockResolvedValue(undefined);

    const MockAudioContext = vi.fn().mockImplementation(() => ({
      decodeAudioData: mockDecodeAudioData,
      close: mockClose,
    }));

    vi.stubGlobal("window", {
      AudioContext: MockAudioContext,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    }));

    const peaks = await generateWaveformData("blob:test", 2);
    expect(peaks.length).toBe(2);
    expect(peaks[0]).toBeCloseTo(0.4, 2);
    expect(peaks[1]).toBeCloseTo(0.8, 2);
    expect(mockClose).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
