// Web engine: ffmpeg.wasm, fully client-side. Files never leave the browser.
// Slower than the desktop app (wasm; "veryfast" preset compensates a little).
import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { OutputFile, VideoFile } from "../store";
import { buildFfmpegArgs, outputName } from "./args";
import type { BatchEvents, BatchItemSpec, BatchOptions, Engine, Thumb } from "./types";

const RELEASES_PAGE = "https://github.com/DarkTama/Kecilin/releases";
const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];
const MOUNT = "/input";

const sourceFiles = new Map<string, File>(); // id -> File
const mediaUrls = new Map<string, string>();
let ffmpeg: FFmpeg | null = null;
let events: BatchEvents | null = null;
let running = false;
let cancelled = false;
let currentIndex: number | null = null;
let skipRequested = false;

const base = import.meta.env.BASE_URL;

async function load(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  const f = new FFmpeg();
  // Single-thread core, deliberately: core-mt wedges on repeat execs with
  // WORKERFS mounts (probe hangs / thumbnails+converts die after the first
  // run — reproduced against 0.12.x). Revisit when upstream stabilizes.
  await f.load({
    coreURL: `${base}ffmpeg/core/ffmpeg-core.js`,
    wasmURL: `${base}ffmpeg/core/ffmpeg-core.wasm`,
    classWorkerURL: `${base}ffmpeg/class/worker.js`,
  });
  ffmpeg = f;
  return f;
}

function fileId(file: File): string {
  return `web:${file.name}:${file.size}:${file.lastModified}`;
}

function isVideoName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}

async function withMount<T>(f: FFmpeg, file: File, run: (input: string) => Promise<T>): Promise<T> {
  await f.createDir(MOUNT);
  // WORKERFS reads the File in place — no copy of the whole video into wasm memory.
  await f.mount("WORKERFS" as never, { files: [file] } as never, MOUNT);
  try {
    return await run(`${MOUNT}/${file.name}`);
  } finally {
    try {
      await f.unmount(MOUNT);
      await f.deleteDir(MOUNT);
    } catch {
      // instance may have been terminated by cancel/skip
    }
  }
}

// Mirrors the Rust header parsers.
function parseDurationSecs(log: string): number | null {
  const m = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function countAudioTracks(log: string): number {
  return log.split("\n").filter((l) => l.includes("Stream #") && l.includes("Audio:")).length;
}

async function probe(file: File): Promise<VideoFile> {
  const f = await load();
  let log = "";
  const onLog = (e: { message: string }) => {
    log += e.message + "\n";
  };
  f.on("log", onLog);
  try {
    await withMount(f, file, async (input) => {
      await f.exec(["-hide_banner", "-i", input]); // exits non-zero; header still logs
    });
  } catch {
    // header parse below works with whatever we got
  }
  f.off("log", onLog);
  return {
    path: fileId(file),
    name: file.name,
    size: file.size,
    duration: parseDurationSecs(log),
    audioTracks: countAudioTracks(log),
  };
}

async function addFiles(list: File[]): Promise<VideoFile[]> {
  const out: VideoFile[] = [];
  for (const file of list) {
    if (!isVideoName(file.name)) continue;
    sourceFiles.set(fileId(file), file);
    out.push(await probe(file));
  }
  return out;
}

async function convertOne(
  item: BatchItemSpec,
  opts: BatchOptions,
  index: number,
  ev: BatchEvents,
): Promise<OutputFile[]> {
  const file = sourceFiles.get(item.path);
  if (!file) throw new Error("source file is no longer available");
  const f = await load();
  const segCount = Math.max(1, item.trims.length);
  const outputs: OutputFile[] = [];

  await withMount(f, file, async (input) => {
    for (let segIdx = 0; segIdx < segCount; segIdx++) {
      const trim = item.trims[segIdx] ?? null;
      const part = item.trims.length > 1 ? segIdx + 1 : null;
      const outName = outputName(file.name, opts.preset.name, part);
      const denomUs =
        (trim ? Math.max(0, trim.end - trim.start) : (item.duration ?? 0)) * 1_000_000;
      const args = buildFfmpegArgs(
        input,
        `/${outName}`,
        opts.preset,
        trim,
        {
          source: item.audioSource === "default" ? null : String(item.audioSource),
          level: item.audio === "keep" ? null : item.audio,
          normalize: item.normalize,
          trackCount: item.audioTracks,
        },
        "veryfast", // wasm is slow enough already
        null, // no GPU encoders in the browser
        opts.extraArgs,
      );
      const onProgress = (e: { progress: number; time: number }) => {
        const segPct =
          denomUs > 0 ? Math.min(1, Math.max(0, e.time / denomUs)) : Math.min(1, e.progress);
        ev.fileProgress(index, ((segIdx + segPct) / segCount) * 100);
      };
      f.on("progress", onProgress);
      let code: number;
      try {
        code = await f.exec(args);
      } finally {
        f.off("progress", onProgress);
      }
      if (code !== 0) {
        const label = part != null ? `part ${part}: ` : "";
        throw new Error(`${label}ffmpeg exited with code ${code}`);
      }
      const data = (await f.readFile(`/${outName}`)) as Uint8Array;
      await f.deleteFile(`/${outName}`);
      const blob = new Blob([data.slice()], { type: "video/mp4" });
      outputs.push({ path: URL.createObjectURL(blob), size: blob.size, name: outName });
    }
  });
  return outputs;
}

async function runBatch(items: BatchItemSpec[], opts: BatchOptions, ev: BatchEvents): Promise<void> {
  let converted = 0;
  let failed = 0;
  let skipped = 0;
  for (let index = 0; index < items.length; index++) {
    if (cancelled) break;
    currentIndex = index;
    skipRequested = false;
    ev.fileStart(index);
    try {
      const outputs = await convertOne(items[index], opts, index, ev);
      converted++;
      ev.fileDone(index, true, false, null, outputs);
    } catch (e) {
      if (cancelled) break;
      if (skipRequested) {
        skipped++;
        ev.fileDone(index, false, true, "skipped", []);
        continue;
      }
      failed++;
      ev.fileDone(index, false, false, e instanceof Error ? e.message : String(e), []);
    }
  }
  const canceled = cancelled;
  cancelled = false;
  running = false;
  currentIndex = null;
  ev.batchDone({ converted, failed, skipped, canceled });
}

export const wasmEngine: Engine = {
  caps: {
    folders: false,
    outputFolder: false,
    reveal: false,
    clipboard: false,
    dragOut: false,
    downloads: true,
    advancedEncode: false,
  },

  async check() {
    await load();
    return "ffmpeg.wasm ready";
  },
  version: async () => __APP_VERSION__,
  checkForUpdates: () => {}, // the site is always the latest version
  openReleases: () => void window.open(RELEASES_PAGE, "_blank"),
  listEncoders: async () => [],

  pickFolder: async () => null,
  scanFolder: async () => [],

  pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = VIDEO_EXTENSIONS.map((e) => `.${e}`).join(",");
      input.onchange = async () => resolve(await addFiles([...(input.files ?? [])]));
      input.oncancel = () => resolve([]);
      input.click();
    });
  },

  onDrop(cb) {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      const list = [...(e.dataTransfer?.files ?? [])];
      if (list.length === 0) return;
      const files = await addFiles(list);
      if (files.length > 0) cb(files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  },

  onBatchEvents(ev) {
    events = ev;
    return () => {
      if (events === ev) events = null;
    };
  },

  async startBatch(items, options) {
    if (running) throw new Error("a batch is already running");
    if (!events) throw new Error("no event sink");
    running = true;
    cancelled = false;
    void runBatch(items, options, events);
  },

  cancelBatch() {
    if (!running) return;
    cancelled = true;
    // terminate kills the worker; the next load() starts a fresh instance.
    try {
      ffmpeg?.terminate();
    } catch {
      // already gone
    }
    ffmpeg = null;
  },

  skipFile(index) {
    // One instance, one file at a time: skipping means killing the current run.
    if (!running || index !== currentIndex) return;
    skipRequested = true;
    try {
      ffmpeg?.terminate();
    } catch {
      // already gone
    }
    ffmpeg = null;
  },

  pickOutDir: async () => null,
  openOutputFolder: () => {},
  revealFile: () => {},
  copyFiles: async () => {},
  dragOut: () => {},

  mediaSrc(path) {
    const cached = mediaUrls.get(path);
    if (cached) return cached;
    const file = sourceFiles.get(path);
    if (!file) return "";
    const url = URL.createObjectURL(file);
    mediaUrls.set(path, url);
    return url;
  },

  preparePreviewProxy: () =>
    Promise.reject(new Error("proxy previews aren't available in the browser")),

  async prepareThumbnail(path, duration): Promise<Thumb> {
    const file = sourceFiles.get(path);
    if (!file) throw new Error("source file is no longer available");
    const f = await load();
    const seek = duration != null ? Math.min(30, Math.max(0, duration * 0.1)) : 0;
    return withMount(f, file, async (input) => {
      for (const ss of [seek, 0]) {
        const code = await f.exec([
          "-y", "-ss", ss.toFixed(3), "-i", input,
          "-frames:v", "1", "-vf", "scale=-2:90", "-q:v", "5", "/thumb.jpg",
        ]);
        if (code === 0) {
          const data = (await f.readFile("/thumb.jpg")) as Uint8Array;
          await f.deleteFile("/thumb.jpg");
          const url = URL.createObjectURL(new Blob([data.slice()], { type: "image/jpeg" }));
          return { url, iconPath: null };
        }
        if (ss === 0) break;
      }
      throw new Error("could not extract a thumbnail");
    });
  },
};
