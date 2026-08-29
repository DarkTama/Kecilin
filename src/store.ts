import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Trim = { start: number; end: number };
export type Preset = "360p" | "480p" | "720p";
export type FileStatus = "queued" | "running" | "done" | "failed" | "canceled";
export type AudioOpt = "keep" | "mute" | "75" | "50" | "25";
export type OutputFile = { path: string; size: number; name?: string };

/** "default" = first track, "merge" = mix all tracks, number = track index. */
export type AudioSource = "default" | "merge" | number;

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

export type Summary = { converted: number; failed: number; canceled: boolean };

type Store = {
  folder: string | null;
  files: FileState[];
  preset: Preset;
  /** Custom output folder; null = `whatsapp_{preset}` next to each video. */
  outDir: string | null;
  /** Preset/outDir the running/last batch used (so "Open output folder" stays correct). */
  batchPreset: Preset;
  batchOutDir: string | null;
  converting: boolean;
  summary: Summary | null;
  ffmpegError: string | null;
  setFfmpegError: (e: string | null) => void;
  setFolder: (folder: string, files: VideoFile[]) => void;
  addFiles: (files: VideoFile[]) => void;
  removeFile: (path: string) => void;
  clearQueue: () => void;
  setPreset: (p: Preset) => void;
  setOutDir: (d: string | null) => void;
  setTrims: (path: string, trims: Trim[]) => void;
  setAudio: (path: string, audio: AudioOpt) => void;
  setAudioSource: (path: string, audioSource: AudioSource) => void;
  setNormalize: (path: string, normalize: boolean) => void;
  startBatch: () => void;
  fileStart: (index: number) => void;
  fileProgress: (index: number, percent: number) => void;
  fileDone: (index: number, ok: boolean, error: string | null, outputs: OutputFile[]) => void;
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
      converting: false,
      summary: null,
      ffmpegError: null,

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

      startBatch: () =>
        set((s) => ({
          converting: true,
          summary: null,
          batchPreset: s.preset,
          batchOutDir: s.outDir,
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

      fileDone: (index, ok, error, outputs) =>
        set((s) => ({
          files: s.files.map((f, i) =>
            i === index
              ? { ...f, status: ok ? "done" : "failed", percent: ok ? 100 : f.percent, error, outputs }
              : f,
          ),
        })),

      batchDone: (summary) =>
        set((s) => ({
          converting: false,
          summary,
          // Anything not finished when the batch ends was canceled.
          files: s.files.map((f) =>
            f.status === "running" || f.status === "queued" ? { ...f, status: "canceled" } : f,
          ),
        })),
    }),
    {
      name: "kecilin-prefs",
      partialize: (s) => ({ preset: s.preset, outDir: s.outDir }),
    },
  ),
);
