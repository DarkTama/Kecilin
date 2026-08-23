import { create } from "zustand";

export type Trim = { start: number; end: number };
export type Preset = "360p" | "480p" | "720p";
export type FileStatus = "queued" | "running" | "done" | "failed" | "canceled";

/** What `scan_directory` returns per file. */
export type VideoFile = {
  path: string;
  name: string;
  size: number;
  duration: number | null;
};

export type FileState = VideoFile & {
  trim: Trim | null;
  status: FileStatus;
  percent: number;
  error: string | null;
};

export type Summary = { converted: number; failed: number; canceled: boolean };

type Store = {
  folder: string | null;
  files: FileState[];
  preset: Preset;
  /** Preset the running/last batch used (so "Open output folder" stays correct). */
  batchPreset: Preset;
  converting: boolean;
  summary: Summary | null;
  ffmpegError: string | null;
  setFfmpegError: (e: string | null) => void;
  setFolder: (folder: string, files: VideoFile[]) => void;
  setPreset: (p: Preset) => void;
  setTrim: (path: string, trim: Trim | null) => void;
  startBatch: () => void;
  fileStart: (index: number) => void;
  fileProgress: (index: number, percent: number) => void;
  fileDone: (index: number, ok: boolean, error: string | null) => void;
  batchDone: (s: Summary) => void;
};

export const useStore = create<Store>((set) => ({
  folder: null,
  files: [],
  preset: "480p",
  batchPreset: "480p",
  converting: false,
  summary: null,
  ffmpegError: null,

  setFfmpegError: (ffmpegError) => set({ ffmpegError }),

  setFolder: (folder, files) =>
    set({
      folder,
      summary: null,
      files: files.map((f) => ({ ...f, trim: null, status: "queued", percent: 0, error: null })),
    }),

  setPreset: (preset) => set({ preset }),

  setTrim: (path, trim) =>
    set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, trim } : f)) })),

  startBatch: () =>
    set((s) => ({
      converting: true,
      summary: null,
      batchPreset: s.preset,
      files: s.files.map((f) => ({ ...f, status: "queued", percent: 0, error: null })),
    })),

  fileStart: (index) =>
    set((s) => ({
      files: s.files.map((f, i) => (i === index ? { ...f, status: "running", percent: 0 } : f)),
    })),

  fileProgress: (index, percent) =>
    set((s) => ({ files: s.files.map((f, i) => (i === index ? { ...f, percent } : f)) })),

  fileDone: (index, ok, error) =>
    set((s) => ({
      files: s.files.map((f, i) =>
        i === index ? { ...f, status: ok ? "done" : "failed", percent: ok ? 100 : f.percent, error } : f,
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
}));
