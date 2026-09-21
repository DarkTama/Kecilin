import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioTrackMixer } from "./mixer";

describe("AudioTrackMixer", () => {
  let mockGainNode: any;
  let mockSourceNode: any;
  let mockAudioContext: any;
  let mockBuffer: any;

  beforeEach(() => {
    mockGainNode = {
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    mockSourceNode = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    mockBuffer = {
      duration: 10,
      numberOfChannels: 2,
      sampleRate: 44100,
    };

    mockAudioContext = {
      state: "suspended",
      currentTime: 1.5,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn().mockReturnValue(mockGainNode),
      createBufferSource: vi.fn().mockImplementation(() => ({ ...mockSourceNode })),
      decodeAudioData: vi.fn().mockResolvedValue(mockBuffer),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes without crashing in test environment without window/AudioContext", () => {
    // default node env or undefined AudioContext
    const mixer = new AudioTrackMixer();
    expect(mixer).toBeDefined();
    expect(mixer.getCurrentPlayhead()).toBe(0);
    mixer.dispose();
  });

  it("initializes with window.AudioContext when available", () => {
    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });

    const mixer = new AudioTrackMixer();
    expect(mixer).toBeDefined();
    mixer.dispose();
    expect(mockAudioContext.close).toHaveBeenCalled();
  });

  it("handles fallback to webkitAudioContext if AudioContext is not present", () => {
    vi.stubGlobal("window", {
      webkitAudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });

    const mixer = new AudioTrackMixer();
    expect(mixer).toBeDefined();
    mixer.dispose();
    expect(mockAudioContext.close).toHaveBeenCalled();
  });

  it("loads a track, decodes audio data, and creates gain node connected to destination", async () => {
    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    }));

    const mixer = new AudioTrackMixer();
    await mixer.loadTrack(0, "blob:track-0");

    expect(mockAudioContext.createGain).toHaveBeenCalledTimes(1);
    expect(mockGainNode.connect).toHaveBeenCalledWith(mockAudioContext.destination);
    expect(mockAudioContext.decodeAudioData).toHaveBeenCalled();

    // Loading same index again does not create second gain node
    await mixer.loadTrack(0, "blob:track-0-alt");
    expect(mockAudioContext.createGain).toHaveBeenCalledTimes(1);

    mixer.dispose();
  });

  it("does not fail loadTrack if AudioContext is not available", async () => {
    vi.stubGlobal("window", {});
    const mixer = new AudioTrackMixer();
    await expect(mixer.loadTrack(0, "blob:track-0")).resolves.toBeUndefined();
    mixer.dispose();
  });

  it("aborts loadTrack gracefully if mixer is disposed during fetch or decode", async () => {
    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    const mixer = new AudioTrackMixer();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      mixer.dispose();
      return {
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
      };
    }));

    await mixer.loadTrack(0, "blob:track-0");
    expect(mockAudioContext.createGain).not.toHaveBeenCalled();
  });

  it("sets track volume and handles muted flag", async () => {
    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    }));

    const mixer = new AudioTrackMixer();
    await mixer.loadTrack(0, "blob:track-0");

    mixer.setTrackVolume(0, 0.8, false);
    expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(0.8, mockAudioContext.currentTime);

    mixer.setTrackVolume(0, 0.8, true);
    expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(0, mockAudioContext.currentTime);

    // Setting volume for non-existent track is safe
    expect(() => mixer.setTrackVolume(99, 0.5)).not.toThrow();

    mixer.dispose();
  });

  it("plays loaded tracks, resumes suspended context, and respects buffer duration", async () => {
    const createdSources: any[] = [];
    mockAudioContext.createBufferSource = vi.fn().mockImplementation(() => {
      const src = { ...mockSourceNode, stop: vi.fn(), disconnect: vi.fn(), start: vi.fn() };
      createdSources.push(src);
      return src;
    });

    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    }));

    const mixer = new AudioTrackMixer();
    await mixer.loadTrack(0, "blob:track-0"); // duration 10

    mixer.play(2);
    expect(mockAudioContext.resume).toHaveBeenCalled();
    expect(createdSources.length).toBe(1);
    expect(createdSources[0].connect).toHaveBeenCalledWith(mockGainNode);
    expect(createdSources[0].start).toHaveBeenCalledWith(0, 2);

    // If play is called past buffer duration, source is not started
    mixer.play(15);
    expect(createdSources[0].stop).toHaveBeenCalled();
    expect(createdSources.length).toBe(1); // no new source created because fromTime >= buffer.duration

    mixer.dispose();
  });

  it("pauses and stops active audio sources", async () => {
    let activeSource: any;
    mockAudioContext.createBufferSource = vi.fn().mockImplementation(() => {
      activeSource = { ...mockSourceNode, stop: vi.fn(), disconnect: vi.fn(), start: vi.fn() };
      return activeSource;
    });

    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    }));

    const mixer = new AudioTrackMixer();
    await mixer.loadTrack(0, "blob:track-0");

    mixer.play(1);
    expect(activeSource.start).toHaveBeenCalled();

    mixer.pause();
    expect(activeSource.stop).toHaveBeenCalled();
    expect(activeSource.disconnect).toHaveBeenCalled();

    mixer.dispose();
  });

  it("seeks correctly when playing vs paused", async () => {
    const createdSources: any[] = [];
    mockAudioContext.createBufferSource = vi.fn().mockImplementation(() => {
      const src = { ...mockSourceNode, stop: vi.fn(), disconnect: vi.fn(), start: vi.fn() };
      createdSources.push(src);
      return src;
    });

    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    }));

    const mixer = new AudioTrackMixer();
    await mixer.loadTrack(0, "blob:track-0");

    // Seek while paused does not create sources
    mixer.seek(4);
    expect(mixer.getCurrentPlayhead()).toBe(4);
    expect(createdSources.length).toBe(0);

    // Play without args uses current playhead
    mixer.play();
    expect(createdSources.length).toBe(1);
    expect(createdSources[0].start).toHaveBeenCalledWith(0, 4);

    // Seek while playing stops previous source and starts playback at new time
    mixer.seek(7);
    expect(mixer.getCurrentPlayhead()).toBe(7);
    expect(createdSources[0].stop).toHaveBeenCalled();
    expect(createdSources.length).toBe(2);
    expect(createdSources[1].start).toHaveBeenCalledWith(0, 7);

    mixer.dispose();
  });

  it("dispose cleans up sources, gain nodes, buffers, and closes AudioContext", async () => {
    let activeSource: any;
    mockAudioContext.createBufferSource = vi.fn().mockImplementation(() => {
      activeSource = { ...mockSourceNode, stop: vi.fn(), disconnect: vi.fn(), start: vi.fn() };
      return activeSource;
    });

    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    }));

    const mixer = new AudioTrackMixer();
    await mixer.loadTrack(0, "blob:track-0");
    mixer.play(1);

    mixer.dispose();
    expect(activeSource.stop).toHaveBeenCalled();
    expect(activeSource.disconnect).toHaveBeenCalled();
    expect(mockGainNode.disconnect).toHaveBeenCalled();
    expect(mockAudioContext.close).toHaveBeenCalled();

    // Calling play or setTrackVolume after dispose does nothing
    expect(() => mixer.play(2)).not.toThrow();
    expect(() => mixer.setTrackVolume(0, 0.5)).not.toThrow();
  });

  it("handles stop error gracefully if source is already stopped and still disconnects", async () => {
    const disconnectFn = vi.fn();
    mockAudioContext.createBufferSource = vi.fn().mockImplementation(() => {
      return {
        ...mockSourceNode,
        stop: vi.fn().mockImplementation(() => {
          throw new Error("InvalidStateError");
        }),
        disconnect: disconnectFn,
        start: vi.fn(),
      };
    });

    vi.stubGlobal("window", {
      AudioContext: vi.fn().mockImplementation(() => mockAudioContext),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(16)),
    }));

    const mixer = new AudioTrackMixer();
    await mixer.loadTrack(0, "blob:track-0");
    mixer.play(1);

    // pause/dispose should not throw and disconnect should be called
    expect(() => mixer.pause()).not.toThrow();
    expect(disconnectFn).toHaveBeenCalled();
    expect(() => mixer.dispose()).not.toThrow();
  });
});
