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
  /** Zero ranges = whole file; one = plain trim; several = multi-part split. */
  trims: Trim[];
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
  setPreset: (p: Preset) => void;
  setOutDir: (d: string | null) => void;
  setTrims: (path: string, trims: Trim[]) => void;
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
  outDir: null,
  batchPreset: "480p",
  batchOutDir: null,
  converting: false,
  summary: null,
  ffmpegError: null,

  setFfmpegError: (ffmpegError) => set({ ffmpegError }),

  setFolder: (folder, files) =>
    set({
      folder,
      summary: null,
      files: files.map((f) => ({ ...f, trims: [], status: "queued", percent: 0, error: null })),
    }),

  addFiles: (files) =>
    set((s) => {
      const known = new Set(s.files.map((f) => f.path));
      const fresh = files
        .filter((f) => !known.has(f.path))
        .map((f) => ({ ...f, trims: [], status: "queued" as const, percent: 0, error: null }));
      return { summary: null, files: [...s.files, ...fresh] };
    }),

  setPreset: (preset) => set({ preset }),

  setOutDir: (outDir) => set({ outDir }),

  setTrims: (path, trims) =>
    set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, trims } : f)) })),

  startBatch: () =>
    set((s) => ({
      converting: true,
      summary: null,
      batchPreset: s.preset,
      batchOutDir: s.outDir,
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
