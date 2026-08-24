import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { FileRow } from "./FileRow";
import { useStore } from "./store";
import { checkForUpdates } from "./updateCheck";
import type { Preset, Summary, VideoFile } from "./store";

const PRESETS: { id: Preset; hint: string }[] = [
  { id: "360p", hint: "small, good for long clips" },
  { id: "480p", hint: "balanced small" },
  { id: "720p", hint: "better quality, gameplay-friendly" },
];

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];

export default function App() {
  const s = useStore();
  const [scanning, setScanning] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("check_ffmpeg").catch((e) => useStore.getState().setFfmpegError(String(e)));
    void checkForUpdates();
    const subs = [
      listen<{ index: number }>("file:start", (e) => useStore.getState().fileStart(e.payload.index)),
      listen<{ index: number; percent: number }>("file:progress", (e) =>
        useStore.getState().fileProgress(e.payload.index, e.payload.percent),
      ),
      listen<{ index: number; ok: boolean; error: string | null }>("file:done", (e) =>
        useStore.getState().fileDone(e.payload.index, e.payload.ok, e.payload.error),
      ),
      listen<Summary>("batch:done", (e) => useStore.getState().batchDone(e.payload)),
      // Drag-and-drop videos anywhere on the window; scan_files skips non-videos.
      getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const st = useStore.getState();
        if (st.converting || event.payload.paths.length === 0) return;
        try {
          const files = await invoke<VideoFile[]>("scan_files", { paths: event.payload.paths });
          st.addFiles(files);
        } catch {
          // non-video drops are silently ignored
        }
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, []);

  async function pickFolder() {
    setUiError(null);
    const dir = await open({ directory: true, title: "Choose a folder with videos" });
    if (typeof dir !== "string") return;
    setScanning(true);
    try {
      const files = await invoke<VideoFile[]>("scan_directory", { path: dir });
      s.setFolder(dir, files);
    } catch (e) {
      setUiError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function pickFiles() {
    setUiError(null);
    const sel = await open({
      multiple: true,
      title: "Choose videos",
      filters: [{ name: "Videos", extensions: VIDEO_EXTENSIONS }],
    });
    const paths = Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];
    if (paths.length === 0) return;
    setScanning(true);
    try {
      const files = await invoke<VideoFile[]>("scan_files", { paths });
      s.addFiles(files);
    } catch (e) {
      setUiError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function pickOutDir() {
    const dir = await open({ directory: true, title: "Choose output folder" });
    if (typeof dir === "string") s.setOutDir(dir);
  }

  async function convert() {
    setUiError(null);
    s.startBatch();
    try {
      await invoke("start_batch", {
        items: s.files.map((f) => ({ path: f.path, duration: f.duration, trims: f.trims })),
        preset: s.preset,
        outDir: s.outDir,
      });
    } catch (e) {
      setUiError(String(e));
      s.batchDone({ converted: 0, failed: 0, canceled: true });
    }
  }

  const hasQueue = s.folder !== null || s.files.length > 0;
  const total = s.files.length;
  const finished = s.files.filter((f) => f.status === "done" || f.status === "failed").length;
  const running = s.files.find((f) => f.status === "running");
  const overall = total ? ((finished + (running ? running.percent / 100 : 0)) / total) * 100 : 0;
  const doneFile = s.files.find((f) => f.status === "done");
  const outLabel = s.outDir
    ? (s.outDir.split(/[\\/]/).filter(Boolean).pop() ?? s.outDir)
    : `whatsapp_${s.preset}`;

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Kecilin<span className="text-emerald-500">.</span>
            </h1>
            <p className="text-sm text-slate-400">Shrink videos until WhatsApp behaves.</p>
          </div>
          {hasQueue && !s.converting && (
            <div className="flex gap-4 text-sm">
              <button
                onClick={pickFiles}
                disabled={scanning}
                className="text-emerald-400 hover:text-emerald-300"
              >
                Add files…
              </button>
              <button
                onClick={pickFolder}
                disabled={scanning}
                className="text-emerald-400 hover:text-emerald-300"
              >
                {scanning ? "Scanning…" : s.folder ? "Change folder…" : "Scan folder…"}
              </button>
            </div>
          )}
        </header>

        {s.ffmpegError && (
          <div className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
            <b>ffmpeg is missing or broken.</b> {s.ffmpegError}
          </div>
        )}
        {uiError && (
          <div className="rounded-xl border border-amber-800 bg-amber-950/60 px-4 py-3 text-sm text-amber-200">
            {uiError}
          </div>
        )}

        {!hasQueue ? (
          <div className="flex flex-col gap-3">
            <button
              onClick={pickFolder}
              disabled={scanning}
              className="rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/50 px-6 py-14 text-lg font-medium hover:border-emerald-600 hover:bg-slate-900 disabled:opacity-60"
            >
              {scanning ? "Scanning…" : "📁 Choose a folder with videos"}
              <span className="mt-2 block text-sm font-normal text-slate-400">
                Scans the top level for {VIDEO_EXTENSIONS.map((e) => `.${e}`).join(" ")}
              </span>
            </button>
            <button
              onClick={pickFiles}
              disabled={scanning}
              className="text-sm text-emerald-400 hover:text-emerald-300 disabled:opacity-60"
            >
              …or pick individual videos — dropping them anywhere here works too
            </button>
          </div>
        ) : (
          <>
            {s.folder && (
              <div className="truncate text-xs text-slate-500" title={s.folder}>
                {s.folder}
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  disabled={s.converting}
                  onClick={() => s.setPreset(p.id)}
                  className={`rounded-xl border px-4 py-3 text-left transition ${
                    s.preset === p.id
                      ? "border-emerald-500 bg-emerald-500/10"
                      : "border-slate-800 bg-slate-900 hover:border-slate-600"
                  } disabled:opacity-60`}
                >
                  <div className="font-semibold">{p.id}</div>
                  <div className="text-xs text-slate-400">{p.hint}</div>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="shrink-0">Output:</span>
              <span className="min-w-0 truncate" title={s.outDir ?? undefined}>
                {s.outDir ?? `whatsapp_${s.preset} inside each video's folder`}
              </span>
              {!s.converting && (
                <>
                  <button
                    onClick={pickOutDir}
                    className="shrink-0 text-emerald-400 hover:text-emerald-300"
                  >
                    Change…
                  </button>
                  {s.outDir && (
                    <button
                      onClick={() => s.setOutDir(null)}
                      className="shrink-0 text-slate-500 hover:text-slate-300"
                    >
                      Reset
                    </button>
                  )}
                </>
              )}
            </div>

            {s.files.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-8 text-center text-sm text-slate-400">
                No videos found in this folder.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {s.files.map((f) => (
                  <FileRow key={f.path} file={f} converting={s.converting} />
                ))}
              </div>
            )}

            {!s.converting && s.files.length > 0 && (
              <button
                onClick={convert}
                disabled={!!s.ffmpegError}
                className="rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                Convert {total} video{total > 1 ? "s" : ""} → {outLabel}
              </button>
            )}

            {s.converting && (
              <div className="flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${overall}%` }}
                  />
                </div>
                <span className="text-sm tabular-nums text-slate-300">
                  {finished}/{total}
                </span>
                <button
                  onClick={() => invoke("cancel_batch")}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
            )}

            {s.summary && !s.converting && (
              <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm">
                <span>
                  {s.summary.canceled && <span className="text-amber-400">Canceled — </span>}
                  {s.summary.converted} converted
                  {s.summary.failed > 0 && (
                    <span className="text-red-400">, {s.summary.failed} failed</span>
                  )}
                </span>
                {doneFile && (
                  <button
                    onClick={() =>
                      invoke("open_output_folder", {
                        anchor: doneFile.path,
                        preset: s.batchPreset,
                        outDir: s.batchOutDir,
                      })
                    }
                    className="font-medium text-emerald-400 hover:text-emerald-300"
                  >
                    Open output folder
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
