import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioDrawer } from "./AudioDrawer";
import type { FileState } from "./store";

describe("AudioDrawer", () => {
  const dummyFile: FileState = {
    path: "/path/video.mp4",
    name: "video.mp4",
    size: 1024,
    duration: 100,
    audioTracks: 2,
    audioTracksInfo: [
      { index: 0, name: "Desktop Audio", enabled: true, volume: 1.0, muted: false },
      { index: 1, name: "Mic / Aux", enabled: false, volume: 1.5, muted: true },
    ],
    trims: [],
    speedRanges: [],
    audio: "keep",
    audioSource: "default",
    normalize: false,
    outputs: [],
    status: "queued",
    percent: 0,
    error: null,
  };

  it("renders track names, volume percentage, boost indicators, and mute states", () => {
    const onTrackChange = vi.fn();
    const html = renderToStaticMarkup(
      <AudioDrawer file={dummyFile} playhead={25} onTrackChange={onTrackChange} />
    );

    expect(html).toContain("Desktop Audio");
    expect(html).toContain("Mic / Aux");
    expect(html).toContain("Audio Tracks (2)");
    // Track 0: volume 1.0 -> 100%, Vol:, Mute
    expect(html).toContain("Vol:");
    expect(html).toContain("100%");
    expect(html).toContain("Mute");
    // Track 1: volume 1.5 -> 150%, Boost:, Muted
    expect(html).toContain("Boost");
    expect(html).toContain("150%");
    expect(html).toContain("Muted");
    // Playhead indicator at 25% (playhead 25 / duration 100)
    expect(html).toContain("left:25%");
  });

  it("clamps playhead percentage between 0 and 100", () => {
    const htmlNegative = renderToStaticMarkup(
      <AudioDrawer file={dummyFile} playhead={-10} onTrackChange={vi.fn()} />
    );
    expect(htmlNegative).toContain("left:0%");

    const htmlOver = renderToStaticMarkup(
      <AudioDrawer file={dummyFile} playhead={150} onTrackChange={vi.fn()} />
    );
    expect(htmlOver).toContain("left:100%");
  });

  it("handles null playhead and empty audio tracks", () => {
    const emptyFile: FileState = {
      ...dummyFile,
      audioTracksInfo: undefined,
      duration: null,
    };
    const html = renderToStaticMarkup(
      <AudioDrawer file={emptyFile} playhead={null} onTrackChange={vi.fn()} />
    );
    expect(html).toContain("Audio Tracks (0)");
    expect(html).not.toContain("left:");
  });
});
