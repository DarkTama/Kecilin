// Mirrors the Rust unit tests in src-tauri/src/commands.rs — the two builders
// must stay byte-for-byte in sync (this one feeds ffmpeg.wasm on the web).
import { describe, expect, it } from "vitest";
import type { SpeedRange } from "../store";
import { BUILTIN_PRESETS } from "../store";
import {
  buildAtempoChain,
  buildFfmpegArgs,
  buildSpeedFiltergraph,
  calculateEffectiveDuration,
  LOUDNORM,
  outputName,
  resolveOutputFilename,
  sanitizeFilename,
  slug,
  solveSpeedMultiplier,
} from "./args";

const p360 = BUILTIN_PRESETS[0];
const p480 = BUILTIN_PRESETS[1];
const p720 = BUILTIN_PRESETS[2];
const noAudio = { source: null, level: null, normalize: false, trackCount: 1 };

describe("buildFfmpegArgs", () => {
  it("matches the compress.bat invocation exactly (360p, no trim)", () => {
    const args = buildFfmpegArgs("in.mp4", "out/in_whatsapp_360p.mp4", p360, null, noAudio);
    expect(args).toEqual([
      "-y", "-i", "in.mp4",
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", "scale=-2:360:flags=lanczos",
      "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
      "-level", "3.1", "-pix_fmt", "yuv420p",
      "-crf", "24", "-maxrate", "1200k", "-bufsize", "2400k",
      "-g", "120", "-keyint_min", "60", "-sc_threshold", "40",
      "-bf", "3", "-refs", "4", "-rc-lookahead", "40",
      "-x264-params", "aq-mode=3:aq-strength=0.8",
      "-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
      "-progress", "pipe:1", "-nostats",
      "out/in_whatsapp_360p.mp4",
    ]);
  });

  it("adds trim seek/duration and the web speed preset", () => {
    const args = buildFfmpegArgs("in.mkv", "out.mp4", p480, { start: 5.5, end: 12 }, noAudio, "veryfast");
    const i = args.indexOf("-i");
    expect(args.slice(i - 2, i + 2)).toEqual(["-ss", "5.500", "-i", "in.mkv"]);
    expect(args.slice(i + 2, i + 4)).toEqual(["-t", "6.500"]);
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
  });

  it("builds the amix graph with the inner filter chain", () => {
    const args = buildFfmpegArgs("in.mkv", "out.mp4", p480, null, {
      source: "merge", level: "50", normalize: true, trackCount: 2,
    });
    const i = args.indexOf("-filter_complex");
    expect(args[i + 1]).toBe(
      `[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0,${LOUDNORM},volume=0.5[aout]`,
    );
    expect(args.slice(i + 2, i + 4)).toEqual(["-map", "[aout]"]);
    expect(args).not.toContain("-af");
  });

  it("maps a selected track and mutes with -an", () => {
    const picked = buildFfmpegArgs("a.mp4", "b.mp4", p480, null, { ...noAudio, source: "1" });
    expect(picked).toContain("0:a:1");
    const muted = buildFfmpegArgs("a.mp4", "b.mp4", p480, null, { ...noAudio, level: "mute" });
    expect(muted).toContain("-an");
    expect(muted).not.toContain("-c:a");
  });

  it("swaps the video block for GPU encoders and keeps the rate ceiling", () => {
    for (const [enc, codec] of [["nvenc", "h264_nvenc"], ["amf", "h264_amf"], ["qsv", "h264_qsv"]]) {
      const a = buildFfmpegArgs("in.mp4", "out.mp4", p720, null, noAudio, "slow", enc);
      expect(a).toContain(codec);
      expect(a).not.toContain("libx264");
      expect(a[a.indexOf("-maxrate") + 1]).toBe("4200k");
    }
  });

  it("puts extra args right before the output", () => {
    const a = buildFfmpegArgs("in.mp4", "out.mp4", p480, null, noAudio, "slow", null, ["-metadata", "title=x"]);
    expect(a.slice(-3)).toEqual(["-metadata", "title=x", "out.mp4"]);
    expect(a[a.length - 4]).toBe("-nostats");
  });

  it("appends -map_metadata -1 when stripMetadata is true", () => {
    const args = buildFfmpegArgs(
      "in.mp4",
      "out.mp4",
      p480,
      null,
      "keep",
      "default",
      false,
      [],
      null,
      true,
    );
    expect(args).toContain("-map_metadata");
    const idx = args.indexOf("-map_metadata");
    expect(args[idx + 1]).toBe("-1");
  });

  it("builds complex filtergraph for sub-range speedup", () => {
    const speedRange: SpeedRange = {
      start: 10,
      end: 20,
      speed: 2.0,
      fitTarget: false,
    };
    const args = buildFfmpegArgs(
      "in.mp4",
      "out.mp4",
      p480,
      { start: 0, end: 30 },
      "keep",
      "default",
      false,
      [],
      speedRange,
      true,
    );

    // Filter complex replaces simple -vf / -af
    expect(args).toContain("-filter_complex");
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-af");
    // Seeking handled inside filter complex, not as command-line flags
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-t");

    const fcIdx = args.indexOf("-filter_complex");
    const fc = args[fcIdx + 1];

    // Pre-speed, sped, post-speed segments
    expect(fc).toContain("trim=start=0:end=10");
    expect(fc).toContain("atrim=start=0:end=10");
    expect(fc).toContain("trim=start=10:end=20");
    expect(fc).toContain("setpts=PTS/2");
    expect(fc).toContain("atrim=start=10:end=20");
    expect(fc).toContain("atempo=2");
    expect(fc).toContain("trim=start=20:end=30");
    expect(fc).toContain("atrim=start=20:end=30");
    expect(fc).toContain("concat=n=3:v=1:a=1[vcat][acat]");
    expect(fc).toContain("[vcat]scale=-2:480:flags=lanczos[vout]");

    // Map args
    expect(args).toContain("-map");
    expect(args).toContain("[vout]");
    expect(args).toContain("[acat]");

    // Metadata stripping
    expect(args).toContain("-map_metadata");
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("-1");
    // Audio encoded with aac
    expect(args).toContain("-c:a");
  });

  it("handles sub-range speedup with audio: 'mute'", () => {
    const speedRange: SpeedRange = {
      start: 10,
      end: 20,
      speed: 2.0,
      fitTarget: false,
    };
    const args = buildFfmpegArgs(
      "in.mp4",
      "out.mp4",
      p480,
      { start: 0, end: 30 },
      "mute",
      "default",
      false,
      [],
      speedRange,
    );

    expect(args).toContain("-filter_complex");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("concat=n=3:v=1:a=0[vcat]");
    expect(fc).not.toContain("atrim");
    expect(fc).not.toContain("atempo");
    expect(args).toContain("-an");
    expect(args).not.toContain("-c:a");
    expect(args).not.toContain("[acat]");
  });

  it("handles sub-range speedup with normalize: true", () => {
    const speedRange: SpeedRange = {
      start: 10,
      end: 20,
      speed: 2.0,
      fitTarget: false,
    };
    const args = buildFfmpegArgs(
      "in.mp4",
      "out.mp4",
      p480,
      { start: 0, end: 30 },
      "keep",
      "default",
      true,
      [],
      speedRange,
    );

    expect(args).toContain("-filter_complex");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(`[acat]${LOUDNORM}[aout]`);
    expect(args).toContain("[aout]");
    expect(args).toContain("-c:a");
  });
  it("includes post-speed segment when trim is null (untrimmed file)", () => {
    const speedRange: SpeedRange = {
      start: 10,
      end: 20,
      speed: 2.0,
      fitTarget: false,
    };
    const args = buildFfmpegArgs(
      "in.mp4",
      "out.mp4",
      p480,
      null,
      "keep",
      "default",
      false,
      [],
      speedRange,
    );

    expect(args).toContain("-filter_complex");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("trim=start=0:end=10");
    expect(fc).toContain("trim=start=10:end=20");
    expect(fc).toContain("trim=start=20,setpts=PTS-STARTPTS[v2]");
    expect(fc).toContain("atrim=start=20,asetpts=PTS-STARTPTS[a2]");
    expect(fc).toContain("concat=n=3:v=1:a=1");
  });

  it("includes bounded post-speed segment when trim is null with explicit duration", () => {
    const speedRange: SpeedRange = {
      start: 10,
      end: 20,
      speed: 2.0,
      fitTarget: false,
    };
    const args = buildFfmpegArgs(
      "in.mp4",
      "out.mp4",
      p480,
      null,
      "keep",
      "default",
      false,
      [],
      speedRange,
      false,
      true,
      50,
    );

    expect(args).toContain("-filter_complex");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("trim=start=20:end=50,setpts=PTS-STARTPTS[v2]");
    expect(fc).toContain("atrim=start=20:end=50,asetpts=PTS-STARTPTS[a2]");
    expect(fc).toContain("concat=n=3:v=1:a=1");
  });
});

describe("buildAtempoChain", () => {
  it("generates single atempo filter for speeds <= 2.0", () => {
    expect(buildAtempoChain(1.5)).toBe("atempo=1.5");
    expect(buildAtempoChain(2.0)).toBe("atempo=2");
  });

  it("generates chained atempo filters for 2.0 < speed <= 4.0", () => {
    expect(buildAtempoChain(3.0)).toBe("atempo=2.0,atempo=1.5");
    expect(buildAtempoChain(4.0)).toBe("atempo=2.0,atempo=2");
  });

  it("generates chained atempo filters for 4.0 < speed <= 8.0", () => {
    expect(buildAtempoChain(8.0)).toBe("atempo=2.0,atempo=2.0,atempo=2");
  });

  it("chains 2.0 factors for speed > 8.0", () => {
    expect(buildAtempoChain(10.0)).toBe("atempo=2.0,atempo=2.0,atempo=2.0,atempo=1.25");
  });
});

describe("calculateEffectiveDuration", () => {
  it("calculates unaccelerated duration with or without trim", () => {
    expect(calculateEffectiveDuration(60, null, null)).toBe(60);
    expect(calculateEffectiveDuration(60, { start: 10, end: 40 }, null)).toBe(30);
    expect(
      calculateEffectiveDuration(60, { start: 10, end: 40 }, {
        start: 15,
        end: 25,
        speed: 1.0,
        fitTarget: false,
      }),
    ).toBe(30);
  });

  it("calculates effective duration with partial speedup", () => {
    // 60s total, speed 2x between 10s and 30s: (10 - 0) + 20/2 + (60 - 30) = 50s
    expect(
      calculateEffectiveDuration(60, null, {
        start: 10,
        end: 30,
        speed: 2.0,
        fitTarget: false,
      }),
    ).toBe(50);

    // Trimmed 10..70 (60s), speed 2x between 20..40 (20s): (20 - 10) + 20/2 + (70 - 40) = 50s
    expect(
      calculateEffectiveDuration(100, { start: 10, end: 70 }, {
        start: 20,
        end: 40,
        speed: 2.0,
        fitTarget: false,
      }),
    ).toBe(50);
  });

  it("calculates effective duration with full clip speedup", () => {
    // Full 60s at 3x: 20s
    expect(
      calculateEffectiveDuration(60, null, {
        start: 0,
        end: 60,
        speed: 3.0,
        fitTarget: false,
      }),
    ).toBe(20);

    // Trimmed 10..40 (30s) at 2x: 15s
    expect(
      calculateEffectiveDuration(60, { start: 10, end: 40 }, {
        start: 10,
        end: 40,
        speed: 2.0,
        fitTarget: false,
      }),
    ).toBe(15);
  });
});

describe("solveSpeedMultiplier", () => {
  it("accurately computes required speed multiplier for target duration", () => {
    // 60s total, speed range 10..50 (40s), fixed = 10 + 10 = 20s.
    // target = 30s -> delta = 10s -> speed = 40 / 10 = 4.0.
    const speed = solveSpeedMultiplier(30, 60, null, 10, 50);
    expect(speed).toBe(4.0);

    // Verify duration equals target
    const eff = calculateEffectiveDuration(60, null, {
      start: 10,
      end: 50,
      speed,
      fitTarget: true,
    });
    expect(eff).toBe(30);
  });

  it("clamps speed multiplier to upper bound 30.0 when target is tight", () => {
    // Target 20.01 with fixed = 20s leaves delta = 0.01s <= 0.05 -> clamped to 30.0
    const speed = solveSpeedMultiplier(20.01, 60, null, 10, 50);
    expect(speed).toBe(30.0);
  });

  it("clamps speed multiplier to lower bound 1.05 when target exceeds duration", () => {
    // Target 100s when original is 60s -> multiplier clamped to 1.05
    const speed = solveSpeedMultiplier(100, 60, null, 10, 50);
    expect(speed).toBe(1.05);
  });
  it("guards against non-finite or <= 0 targetDuration by returning 1.0", () => {
    expect(solveSpeedMultiplier(NaN, 60, null, 10, 50)).toBe(1.0);
    expect(solveSpeedMultiplier(Number.POSITIVE_INFINITY, 60, null, 10, 50)).toBe(1.0);
    expect(solveSpeedMultiplier(0, 60, null, 10, 50)).toBe(1.0);
    expect(solveSpeedMultiplier(-15, 60, null, 10, 50)).toBe(1.0);
  });
});

describe("buildSpeedFiltergraph", () => {
  it("builds 3 segments with video scale and audio atempo", () => {
    const res = buildSpeedFiltergraph({
      trim: { start: 0, end: 30 },
      speedRange: { start: 10, end: 20, speed: 2.0, fitTarget: false },
      height: 480,
      hasAudio: true,
      audio: "keep",
      normalize: false,
    });

    expect(res.filterComplex).toBe(
      "[0:v]trim=start=0:end=10,setpts=PTS-STARTPTS[v0];" +
      "[0:a]atrim=start=0:end=10,asetpts=PTS-STARTPTS[a0];" +
      "[0:v]trim=start=10:end=20,setpts=PTS-STARTPTS,setpts=PTS/2[v1];" +
      "[0:a]atrim=start=10:end=20,asetpts=PTS-STARTPTS,atempo=2[a1];" +
      "[0:v]trim=start=20:end=30,setpts=PTS-STARTPTS[v2];" +
      "[0:a]atrim=start=20:end=30,asetpts=PTS-STARTPTS[a2];" +
      "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vcat][acat];" +
      "[vcat]scale=-2:480:flags=lanczos[vout]",
    );
    expect(res.mapArgs).toEqual(["-map", "[vout]", "-map", "[acat]"]);
  });

  it("handles audio: 'mute' by omitting audio trims and mapping video only", () => {
    const res = buildSpeedFiltergraph({
      trim: { start: 0, end: 30 },
      speedRange: { start: 10, end: 20, speed: 2.0, fitTarget: false },
      height: 480,
      hasAudio: true,
      audio: "mute",
      normalize: false,
    });

    expect(res.filterComplex).toBe(
      "[0:v]trim=start=0:end=10,setpts=PTS-STARTPTS[v0];" +
      "[0:v]trim=start=10:end=20,setpts=PTS-STARTPTS,setpts=PTS/2[v1];" +
      "[0:v]trim=start=20:end=30,setpts=PTS-STARTPTS[v2];" +
      "[v0][v1][v2]concat=n=3:v=1:a=0[vcat];" +
      "[vcat]scale=-2:480:flags=lanczos[vout]",
    );
    expect(res.mapArgs).toEqual(["-map", "[vout]"]);
  });

  it("chains loudnorm when normalize: true", () => {
    const res = buildSpeedFiltergraph({
      trim: { start: 0, end: 30 },
      speedRange: { start: 10, end: 20, speed: 2.0, fitTarget: false },
      height: 480,
      hasAudio: true,
      audio: "keep",
      normalize: true,
    });

    expect(res.filterComplex).toContain(`;[acat]${LOUDNORM}[aout]`);
    expect(res.mapArgs).toEqual(["-map", "[vout]", "-map", "[aout]"]);
  });
  it("emits open-ended post-speed segment when trim is null", () => {
    const res = buildSpeedFiltergraph({
      trim: null,
      speedRange: { start: 5, end: 15, speed: 3.0, fitTarget: false },
      height: 720,
      hasAudio: true,
      audio: "keep",
      normalize: false,
    });

    expect(res.filterComplex).toContain("[0:v]trim=start=15,setpts=PTS-STARTPTS[v2]");
    expect(res.filterComplex).toContain("[0:a]atrim=start=15,asetpts=PTS-STARTPTS[a2]");
    expect(res.filterComplex).toContain("concat=n=3:v=1:a=1");
  });
});

describe("sanitizeFilename", () => {
  it("replaces illegal characters with underscores", () => {
    expect(sanitizeFilename("foo/bar\\baz:qux*one?two\"three<four>five|six")).toBe(
      "foo_bar_baz_qux_one_two_three_four_five_six",
    );
  });

  it("trims leading and trailing whitespace and periods", () => {
    expect(sanitizeFilename("  ...my_file.mp4...  ")).toBe("my_file.mp4");
    expect(sanitizeFilename(" . foo:bar . ")).toBe("foo_bar");
  });
});

describe("naming", () => {
  it("mirrors the desktop naming and slugging", () => {
    expect(outputName("clip.mkv", "480p", null)).toBe("clip_whatsapp_480p.mp4");
    expect(outputName("clip.mkv", "360p", 2)).toBe("clip_whatsapp_360p_part2.mp4");
    expect(slug("My Phone (HD)!")).toBe("My_Phone__HD");
    expect(slug("***")).toBe("custom");
    expect(outputName("clip.mp4", "Story 1080", null)).toBe("clip_whatsapp_Story_1080.mp4");
  });

  it("supports default pattern with resolveOutputFilename", () => {
    expect(
      resolveOutputFilename({
        stem: "clip.mkv",
        presetName: "480p",
        part: null,
      }),
    ).toBe("clip_whatsapp_480p.mp4");

    expect(
      resolveOutputFilename({
        stem: "clip.mkv",
        presetName: "360p",
        part: 2,
      }),
    ).toBe("clip_whatsapp_360p_part2.mp4");
  });

  it("supports custom pattern with date, name, resolution, and part", () => {
    const fixedDate = new Date(2026, 8, 20); // 2026-09-20
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        height: 480,
        part: 1,
        pattern: "{date}_{name}_{resolution}{part}",
        now: fixedDate,
      }),
    ).toBe("20260920_clip_480p_part1.mp4");
  });

  it("supports {stem} token synonym", () => {
    expect(
      resolveOutputFilename({
        stem: "holiday",
        presetName: "720p",
        height: 720,
        part: null,
        pattern: "{stem}_{resolution}",
      }),
    ).toBe("holiday_720p.mp4");
  });

  it("falls back to presetName when height is omitted or unknown", () => {
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "Story 1080",
        pattern: "{name}_{resolution}",
      }),
    ).toBe("clip_Story 1080.mp4");
  });

  it("overrides template completely with customName", () => {
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        customName: "My Custom Highlights",
      }),
    ).toBe("My Custom Highlights.mp4");
  });

  it("sanitizes illegal characters in customName", () => {
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        customName: "Cool:Clip/1",
      }),
    ).toBe("Cool_Clip_1.mp4");
  });

  it("retains existing .mp4 on customName without duplicating", () => {
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        customName: "clip.mp4",
      }),
    ).toBe("clip.mp4");

    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        customName: "clip.MP4",
      }),
    ).toBe("clip.MP4");
  });

  it("falls back to template if customName is empty or only whitespace", () => {
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        customName: "   ",
      }),
    ).toBe("clip_whatsapp_480p.mp4");
  });

  it("auto-appends _part suffix when multi-part is missing {part} token", () => {
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        part: 2,
        pattern: "{name}_{preset}",
      }),
    ).toBe("clip_480p_part2.mp4");

    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        part: 1,
        totalParts: 2,
        pattern: "{name}_{preset}",
      }),
    ).toBe("clip_480p_part1.mp4");
  });

  it("does not auto-append part suffix if totalParts is 1", () => {
    expect(
      resolveOutputFilename({
        stem: "clip",
        presetName: "480p",
        part: 1,
        totalParts: 1,
        pattern: "{name}_{preset}",
      }),
    ).toBe("clip_480p.mp4");
  });

  it("delegates from outputName with optional arguments", () => {
    expect(outputName("clip.mkv", "480p", null, "{name}_{preset}")).toBe(
      "clip_480p.mp4",
    );
    expect(
      outputName("clip.mkv", "480p", 2, "{name}_{preset}", "Direct Override"),
    ).toBe("Direct Override.mp4");
    expect(
      outputName("clip.mkv", "480p", null, "{name}_{resolution}", undefined, 1080),
    ).toBe("clip_1080p.mp4");
  });
});
