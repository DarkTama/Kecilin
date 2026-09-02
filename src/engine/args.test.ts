// Mirrors the Rust unit tests in src-tauri/src/commands.rs — the two builders
// must stay byte-for-byte in sync (this one feeds ffmpeg.wasm on the web).
import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS } from "../store";
import { buildFfmpegArgs, LOUDNORM, outputName, slug } from "./args";

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
});

describe("naming", () => {
  it("mirrors the desktop naming and slugging", () => {
    expect(outputName("clip.mkv", "480p", null)).toBe("clip_whatsapp_480p.mp4");
    expect(outputName("clip.mkv", "360p", 2)).toBe("clip_whatsapp_360p_part2.mp4");
    expect(slug("My Phone (HD)!")).toBe("My_Phone__HD");
    expect(slug("***")).toBe("custom");
    expect(outputName("clip.mp4", "Story 1080", null)).toBe("clip_whatsapp_Story_1080.mp4");
  });
});
