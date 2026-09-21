import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store";

describe("store multi-track audio actions", () => {
  beforeEach(() => {
    useStore.setState({
      files: [
        {
          path: "/test/video.mp4",
          name: "video.mp4",
          size: 1000,
          duration: 60,
          audioTracks: 2,
          audioTracksInfo: [
            { index: 0, name: "Desktop", enabled: true, volume: 1.0, muted: false },
            { index: 1, name: "Mic", enabled: true, volume: 1.0, muted: false },
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
        },
      ],
    });
  });

  it("updates track enabled and volume state", () => {
    const { setTrackEnabled, setTrackVolume } = useStore.getState();
    setTrackEnabled("/test/video.mp4", 1, false);
    setTrackVolume("/test/video.mp4", 0, 1.4);

    const f = useStore.getState().files[0];
    expect(f.audioTracksInfo?.[1].enabled).toBe(false);
    expect(f.audioTracksInfo?.[0].volume).toBe(1.4);
  });

  it("updates track muted state", () => {
    const { setTrackMuted } = useStore.getState();
    setTrackMuted("/test/video.mp4", 0, true);

    const f = useStore.getState().files[0];
    expect(f.audioTracksInfo?.[0].muted).toBe(true);
  });
});
