// Desktop engine: thin wrapper over the Tauri commands and events.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { checkForUpdates, RELEASES_PAGE } from "../updateCheck";
import type { OutputFile, Summary, VideoFile } from "../store";
import type { BatchEvents, BatchItemSpec, BatchOptions, Engine, Thumb } from "./types";

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];

// Clipboard file copy (clipboard-win) and drag-out (tauri-plugin-drag) are
// wired up on Windows only for now.
const isWindows = navigator.userAgent.includes("Windows");

export const tauriEngine: Engine = {
  caps: {
    folders: true,
    outputFolder: true,
    reveal: true,
    clipboard: isWindows,
    dragOut: isWindows,
    downloads: false,
    advancedEncode: true,
  },

  check: () => invoke<string>("check_ffmpeg"),
  version: () => getVersion(),
  checkForUpdates: () => void checkForUpdates(),
  openReleases: () => void openUrl(RELEASES_PAGE),
  listEncoders: () => invoke<string[]>("list_encoders").catch(() => []),

  async pickFolder(recursive) {
    const dir = await open({ directory: true, title: "Choose a folder with videos" });
    if (typeof dir !== "string") return null;
    const files = await invoke<VideoFile[]>("scan_directory", { path: dir, recursive });
    return { folder: dir, files };
  },

  scanFolder: (folder, recursive) =>
    invoke<VideoFile[]>("scan_directory", { path: folder, recursive }),

  async pickFiles() {
    const sel = await open({
      multiple: true,
      title: "Choose videos",
      filters: [{ name: "Videos", extensions: VIDEO_EXTENSIONS }],
    });
    const paths = Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];
    if (paths.length === 0) return [];
    return invoke<VideoFile[]>("scan_files", { paths });
  },

  onDrop(cb) {
    const un = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop" || event.payload.paths.length === 0) return;
      try {
        cb(await invoke<VideoFile[]>("scan_files", { paths: event.payload.paths }));
      } catch {
        // non-video drops are silently ignored
      }
    });
    return () => void un.then((u) => u());
  },

  onBatchEvents(ev: BatchEvents) {
    const subs = [
      listen<{ index: number }>("file:start", (e) => ev.fileStart(e.payload.index)),
      listen<{ index: number; percent: number }>("file:progress", (e) =>
        ev.fileProgress(e.payload.index, e.payload.percent),
      ),
      listen<{
        index: number;
        ok: boolean;
        skipped: boolean;
        error: string | null;
        outputs: OutputFile[];
      }>("file:done", (e) =>
        ev.fileDone(e.payload.index, e.payload.ok, e.payload.skipped, e.payload.error, e.payload.outputs),
      ),
      listen<Summary>("batch:done", (e) => ev.batchDone(e.payload)),
    ];
    return () => subs.forEach((p) => p.then((un) => un()));
  },

  startBatch(items: BatchItemSpec[], options: BatchOptions) {
    return invoke("start_batch", {
      items: items.map((f) => ({
        path: f.path,
        duration: f.duration,
        trims: f.trims,
        audio: f.audio === "keep" ? null : f.audio,
        audioSource: f.audioSource === "default" ? null : String(f.audioSource),
        normalize: f.normalize,
        audioTracks: f.audioTracks,
      })),
      options: {
        preset: options.preset,
        outDir: options.outDir,
        parallel: options.parallel,
        overwrite: options.overwrite,
        encoder: options.encoder,
        extraArgs: options.extraArgs,
      },
    });
  },

  cancelBatch: () => void invoke("cancel_batch"),
  skipFile: (index) => void invoke("skip_file", { index }),

  async pickOutDir() {
    const dir = await open({ directory: true, title: "Choose output folder" });
    return typeof dir === "string" ? dir : null;
  },

  openOutputFolder: (anchor, preset, outDir) =>
    void invoke("open_output_folder", { anchor, preset, outDir }),
  revealFile: (path) => void invoke("reveal_file", { path }),
  copyFiles: (paths) => invoke("copy_file_to_clipboard", { paths }),
  dragOut: (paths, icon) => void startDrag({ item: paths, icon }),

  mediaSrc: (path) => convertFileSrc(path),
  preparePreviewProxy: async (path) => {
    const p = await invoke<string>("prepare_preview", { path });
    return convertFileSrc(p);
  },
  prepareThumbnail: async (path, duration): Promise<Thumb> => {
    const p = await invoke<string>("prepare_thumbnail", { path, duration });
    return { url: convertFileSrc(p), iconPath: p };
  },
};
