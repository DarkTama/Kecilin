import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FileRow } from "./FileRow";
import { fmtSize } from "./format";
import { useStore } from "./store";
import { checkForUpdates, RELEASES_PAGE } from "./updateCheck";
import type { FileState, OutputFile, Preset, Summary, VideoFile } from "./store";

const PRESETS: { id: Preset; hint: string; maxrateKbps: number }[] = [
  { id: "360p", hint: "small, good for long clips", maxrateKbps: 1200 },
  { id: "480p", hint: "balanced small", maxrateKbps: 2200 },
  { id: "720p", hint: "better quality, gameplay-friendly", maxrateKbps: 4200 },
];

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];

/** Seconds that will actually be encoded for a file (trims respected). */
function effectiveSecs(f: FileState): number {
  if (f.trims.length > 0) return f.trims.reduce((a, t) => a + Math.max(0, t.end - t.start), 0);
  return f.duration ?? 0;
}

export default function App() {
  const s = useStore();
  const [scanning, setScanning] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    invoke<string>("check_ffmpeg").catch((e) => useStore.getState().setFfmpegError(String(e)));
    void checkForUpdates();
    getVersion().then(setVersion).catch(() => {});
    const subs = [
      listen<{ index: number }>("file:start", (e) => useStore.getState().fileStart(e.payload.index)),
      listen<{ index: number; percent: number }>("file:progress", (e) =>
        useStore.getState().fileProgress(e.payload.index, e.payload.percent),
      ),
      listen<{ index: number; ok: boolean; error: string | null; outputs: OutputFile[] }>(
        "file:done",
        (e) =>
          useStore
            .getState()
            .fileDone(e.payload.index, e.payload.ok, e.payload.error, e.payload.outputs),
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
        items: s.files.map((f) => ({
          path: f.path,
          duration: f.duration,
          trims: f.trims,
          audio: f.audio === "keep" ? null : f.audio,
          audioSource: f.audioSource === "default" ? null : String(f.audioSource),
          normalize: f.normalize,
          audioTracks: f.audioTracks,
        })),
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
  const doneFiles = s.files.filter((f) => f.status === "done" && f.outputs.length > 0);
  const savedIn = doneFiles.reduce((a, f) => a + f.size, 0);
  const savedOut = doneFiles.reduce((a, f) => a + f.outputs.reduce((x, o) => x + o.size, 0), 0);
  const outLabel = s.outDir
    ? (s.outDir.split(/[\\/]/).filter(Boolean).pop() ?? s.outDir)
    : `whatsapp_${s.preset}`;
  // Ceiling estimate: video maxrate + ~160 kbps AAC over the encoded seconds.
  const totalSecs = s.files.reduce((a, f) => a + effectiveSecs(f), 0);
  const estimateBytes = (kbps: number) => ((kbps + 160) * 1000 * totalSecs) / 8;

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-6 py-8">
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
              {s.files.length > 0 && (
                <button onClick={() => s.clearQueue()} className="text-slate-500 hover:text-slate-300">
                  Clear queue
                </button>
              )}
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
              {PRESETS.map((p) => {
                const est = estimateBytes(p.maxrateKbps);
                return (
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
                    {totalSecs > 0 && (
                      <div
                        className="mt-1 text-[11px] text-slate-500"
                        title="Worst-case estimate for the whole queue: video maxrate + audio over the encoded seconds"
                      >
                        ≤ ~{fmtSize(est)}
                        {est <= 64 * 1024 * 1024 && (
                          <span className="text-emerald-500"> · fits 64 MB ✓</span>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
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
                  {savedOut > 0 && savedIn > savedOut && (
                    <span className="text-slate-400">
                      {" "}
                      · saved {fmtSize(savedIn - savedOut)} (−
                      {Math.round(((savedIn - savedOut) / savedIn) * 100)}%)
                    </span>
                  )}
                </span>
                {doneFiles.length > 0 && (
                  <button
                    onClick={() =>
                      invoke("open_output_folder", {
                        anchor: doneFiles[0].path,
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
      <footer className="pb-4 text-center text-xs text-slate-600">
        Kecilin {version && `v${version}`} ·{" "}
        <button onClick={() => openUrl(RELEASES_PAGE)} className="hover:text-slate-400">
          releases
        </button>
      </footer>
    </div>
  );
}
