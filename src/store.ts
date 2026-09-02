import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Trim = { start: number; end: number };
export type FileStatus = "queued" | "running" | "done" | "failed" | "canceled" | "skipped";
export type AudioOpt = "keep" | "mute" | "75" | "50" | "25";
export type OutputFile = { path: string; size: number; name?: string };
/** "default" = first track, "merge" = mix all tracks, number = track index. */
export type AudioSource = "default" | "merge" | number;
export type Overwrite = "overwrite" | "skip" | "rename";
export type Lang = "en" | "id";

/** Full encode parameters — what the Rust/wasm engines actually consume. */
export type PresetSpec = {
  name: string;
  height: number;
  crf: number;
  maxrate: string;
  bufsize: string;
  level: string;
};

/** A user-defined preset from the Advanced panel (bufsize = 2× maxrate). */
export type CustomPreset = {
  name: string;
  height: number;
  crf: number;
  maxrateKbps: number;
  level: string;
};

export const BUILTIN_PRESETS: PresetSpec[] = [
  { name: "360p", height: 360, crf: 24, maxrate: "1200k", bufsize: "2400k", level: "3.1" },
  { name: "480p", height: 480, crf: 22, maxrate: "2200k", bufsize: "4400k", level: "3.1" },
  { name: "720p", height: 720, crf: 20, maxrate: "4200k", bufsize: "8400k", level: "4.1" },
];

export function customToSpec(c: CustomPreset): PresetSpec {
  return {
    name: c.name,
    height: c.height,
    crf: c.crf,
    maxrate: `${c.maxrateKbps}k`,
    bufsize: `${c.maxrateKbps * 2}k`,
    level: c.level,
  };
}

/** Resolve a preset name (built-in or custom) to its spec; falls back to 480p. */
export function resolvePreset(name: string, custom: CustomPreset[]): PresetSpec {
  return (
    BUILTIN_PRESETS.find((p) => p.name === name) ??
    custom.filter((c) => c.name === name).map(customToSpec)[0] ??
    BUILTIN_PRESETS[1]
  );
}

/** "2200k" → 2200 */
export function maxrateKbps(spec: PresetSpec): number {
  return Number.parseInt(spec.maxrate, 10) || 0;
}

/** What `scan_directory`/`scan_files` return per file. */
export type VideoFile = {
  path: string;
  name: string;
  size: number;
  duration: number | null;
  audioTracks: number;
};

export type FileState = VideoFile & {
  /** Zero ranges = whole file; one = plain trim; several = multi-part split. */
  trims: Trim[];
  audio: AudioOpt;
  audioSource: AudioSource;
  normalize: boolean;
  /** Converted outputs (path + size), filled when the file finishes. */
  outputs: OutputFile[];
  status: FileStatus;
  percent: number;
  error: string | null;
};

export type Summary = { converted: number; failed: number; skipped: number; canceled: boolean };

type Store = {
  folder: string | null;
  files: FileState[];
  preset: string;
  /** Custom output folder; null = `whatsapp_{preset}` next to each video. */
  outDir: string | null;
  /** Preset/outDir the running/last batch used (so "Open output folder" stays correct). */
  batchPreset: string;
  batchOutDir: string | null;
  batchStartedAt: number | null;
  converting: boolean;
  summary: Summary | null;
  ffmpegError: string | null;
  // persisted preferences
  lang: Lang;
  recursive: boolean;
  parallel: number;
  overwrite: Overwrite;
  encoder: string | null;
  extraArgs: string;
  customPresets: CustomPreset[];

  setFfmpegError: (e: string | null) => void;
  setFolder: (folder: string, files: VideoFile[]) => void;
  addFiles: (files: VideoFile[]) => void;
  removeFile: (path: string) => void;
  clearQueue: () => void;
  setPreset: (p: string) => void;
  setOutDir: (d: string | null) => void;
  setTrims: (path: string, trims: Trim[]) => void;
  setAudio: (path: string, audio: AudioOpt) => void;
  setAudioSource: (path: string, audioSource: AudioSource) => void;
  setNormalize: (path: string, normalize: boolean) => void;
  setLang: (lang: Lang) => void;
  setRecursive: (recursive: boolean) => void;
  setParallel: (parallel: number) => void;
  setOverwrite: (overwrite: Overwrite) => void;
  setEncoder: (encoder: string | null) => void;
  setExtraArgs: (extraArgs: string) => void;
  addCustomPreset: (p: CustomPreset) => void;
  removeCustomPreset: (name: string) => void;
  startBatch: () => void;
  fileStart: (index: number) => void;
  fileProgress: (index: number, percent: number) => void;
  fileDone: (
    index: number,
    ok: boolean,
    skipped: boolean,
    error: string | null,
    outputs: OutputFile[],
  ) => void;
  batchDone: (s: Summary) => void;
};

const fresh = (f: VideoFile): FileState => ({
  ...f,
  trims: [],
  audio: "keep",
  audioSource: "default",
  normalize: false,
  outputs: [],
  status: "queued",
  percent: 0,
  error: null,
});

export const useStore = create<Store>()(
  persist(
    (set) => ({
      folder: null,
      files: [],
      preset: "480p",
      outDir: null,
      batchPreset: "480p",
      batchOutDir: null,
      batchStartedAt: null,
      converting: false,
      summary: null,
      ffmpegError: null,
      lang: "en",
      recursive: false,
      parallel: 1,
      overwrite: "overwrite",
      encoder: null,
      extraArgs: "",
      customPresets: [],

      setFfmpegError: (ffmpegError) => set({ ffmpegError }),

      setFolder: (folder, files) => set({ folder, summary: null, files: files.map(fresh) }),

      addFiles: (files) =>
        set((s) => {
          const known = new Set(s.files.map((f) => f.path));
          const added = files.filter((f) => !known.has(f.path)).map(fresh);
          return { summary: null, files: [...s.files, ...added] };
        }),

      removeFile: (path) => set((s) => ({ files: s.files.filter((f) => f.path !== path) })),

      clearQueue: () => set({ files: [], folder: null, summary: null }),

      setPreset: (preset) => set({ preset }),
      setOutDir: (outDir) => set({ outDir }),

      setTrims: (path, trims) =>
        set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, trims } : f)) })),
      setAudio: (path, audio) =>
        set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, audio } : f)) })),
      setAudioSource: (path, audioSource) =>
        set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, audioSource } : f)) })),
      setNormalize: (path, normalize) =>
        set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, normalize } : f)) })),

      setLang: (lang) => set({ lang }),
      setRecursive: (recursive) => set({ recursive }),
      setParallel: (parallel) => set({ parallel: Math.max(1, Math.floor(parallel)) }),
      setOverwrite: (overwrite) => set({ overwrite }),
      setEncoder: (encoder) => set({ encoder }),
      setExtraArgs: (extraArgs) => set({ extraArgs }),
      addCustomPreset: (p) =>
        set((s) => ({
          customPresets: [...s.customPresets.filter((c) => c.name !== p.name), p],
        })),
      removeCustomPreset: (name) =>
        set((s) => ({
          customPresets: s.customPresets.filter((c) => c.name !== name),
          preset: s.preset === name ? "480p" : s.preset,
        })),

      startBatch: () =>
        set((s) => ({
          converting: true,
          summary: null,
          batchPreset: s.preset,
          batchOutDir: s.outDir,
          batchStartedAt: Date.now(),
          files: s.files.map((f) => ({
            ...f,
            status: "queued" as const,
            percent: 0,
            error: null,
            outputs: [],
          })),
        })),

      fileStart: (index) =>
        set((s) => ({
          files: s.files.map((f, i) => (i === index ? { ...f, status: "running", percent: 0 } : f)),
        })),

      fileProgress: (index, percent) =>
        set((s) => ({ files: s.files.map((f, i) => (i === index ? { ...f, percent } : f)) })),

      fileDone: (index, ok, skipped, error, outputs) =>
        set((s) => ({
          files: s.files.map((f, i) =>
            i === index
              ? {
                  ...f,
                  status: ok ? "done" : skipped ? "skipped" : "failed",
                  percent: ok ? 100 : f.percent,
                  error,
                  outputs,
                }
              : f,
          ),
        })),

      batchDone: (summary) =>
        set((s) => ({
          converting: false,
          summary,
          batchStartedAt: null,
          // Anything not finished when the batch ends was canceled.
          files: s.files.map((f) =>
            f.status === "running" || f.status === "queued" ? { ...f, status: "canceled" } : f,
          ),
        })),
    }),
    {
      name: "kecilin-prefs",
      partialize: (s) => ({
        preset: s.preset,
        outDir: s.outDir,
        lang: s.lang,
        recursive: s.recursive,
        parallel: s.parallel,
        overwrite: s.overwrite,
        encoder: s.encoder,
        extraArgs: s.extraArgs,
        customPresets: s.customPresets,
      }),
    },
  ),
);
