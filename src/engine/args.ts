// TS port of src-tauri/src/commands.rs build_ffmpeg_args — used only by the
// web (ffmpeg.wasm) engine. Keep byte-for-byte in sync with the Rust builder;
// args.test.ts mirrors the Rust unit tests to hold the line.
import type { Preset, Trim } from "../store";

export const PRESET_TABLE: Record<
  Preset,
  { height: number; crf: number; maxrate: string; bufsize: string; level: string }
> = {
  "360p": { height: 360, crf: 24, maxrate: "1200k", bufsize: "2400k", level: "3.1" },
  "480p": { height: 480, crf: 22, maxrate: "2200k", bufsize: "4400k", level: "3.1" },
  "720p": { height: 720, crf: 20, maxrate: "4200k", bufsize: "8400k", level: "4.1" },
};

export const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

export type AudioArgOpts = {
  source: string | null; // null/"default" | "merge" | "0","1",…
  level: string | null; // null | "mute" | "75"|"50"|"25"
  normalize: boolean;
  trackCount: number;
};

export function buildFfmpegArgs(
  input: string,
  output: string,
  presetId: Preset,
  trim: Trim | null,
  audio: AudioArgOpts,
  /** "slow" matches the script/desktop; the web build uses "veryfast". */
  speed: "slow" | "veryfast" = "slow",
): string[] {
  const p = PRESET_TABLE[presetId];
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
  a.push(
    "-vf", `scale=-2:${p.height}:flags=lanczos`,
    "-c:v", "libx264", "-preset", speed, "-profile:v", "high",
    "-level", p.level, "-pix_fmt", "yuv420p",
    "-crf", String(p.crf), "-maxrate", p.maxrate, "-bufsize", p.bufsize,
    "-g", "120", "-keyint_min", "60", "-sc_threshold", "40",
    "-bf", "3", "-refs", "4", "-rc-lookahead", "40",
    "-x264-params", "aq-mode=3:aq-strength=0.8",
  );
  if (mute) {
    a.push("-an");
  } else {
    if (!merge && af.length) a.push("-af", af.join(","));
    a.push("-c:a", "aac", "-q:a", "2", "-ar", "48000", "-ac", "2");
  }
  a.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output);
  return a;
}

/** `{stem}_whatsapp_{preset}[_partN].mp4` — same naming as the desktop app. */
export function outputName(inputName: string, preset: Preset, part: number | null): string {
  const stem = inputName.replace(/\.[^.]+$/, "");
  const suffix = part != null ? `_part${part}` : "";
  return `${stem}_whatsapp_${preset}${suffix}.mp4`;
}
