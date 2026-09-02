import { useEffect, useState } from "react";
import { FileRow } from "./FileRow";
import { engine, IS_WEB } from "./engine";
import { slug } from "./engine/args";
import { fmtSize } from "./format";
import { useT } from "./i18n";
import { BUILTIN_PRESETS, customToSpec, maxrateKbps, resolvePreset, useStore } from "./store";
import type { FileState, Overwrite, PresetSpec } from "./store";
import type { Key } from "./i18n";

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];
const BUILTIN_HINTS: Record<string, Key> = { "360p": "hint360", "480p": "hint480", "720p": "hint720" };
const ENCODER_NAMES: Record<string, string> = {
  nvenc: "NVIDIA NVENC",
  amf: "AMD AMF",
  qsv: "Intel Quick Sync",
};
const LEVELS = ["3.0", "3.1", "4.0", "4.1", "4.2", "5.1"];

/** Seconds that will actually be encoded for a file (trims respected). */
function effectiveSecs(f: FileState): number {
  if (f.trims.length > 0) return f.trims.reduce((a, t) => a + Math.max(0, t.end - t.start), 0);
  return f.duration ?? 0;
}

function fmtEta(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export default function App() {
  const s = useStore();
  const t = useT();
  const [scanning, setScanning] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const [encoders, setEncoders] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [draft, setDraft] = useState({ name: "", height: 1080, crf: 20, maxrateKbps: 6000, level: "4.2" });

  useEffect(() => {
    engine.check().catch((e) => useStore.getState().setFfmpegError(String(e)));
    engine.checkForUpdates();
    engine.version().then(setVersion).catch(() => {});
    if (engine.caps.advancedEncode) engine.listEncoders().then(setEncoders);
    const unBatch = engine.onBatchEvents({
      fileStart: (i) => useStore.getState().fileStart(i),
      fileProgress: (i, p) => useStore.getState().fileProgress(i, p),
      fileDone: (i, ok, skipped, err, outputs) =>
        useStore.getState().fileDone(i, ok, skipped, err, outputs),
      batchDone: (sum) => useStore.getState().batchDone(sum),
    });
    const unDrop = engine.onDrop((files) => {
      if (!useStore.getState().converting) useStore.getState().addFiles(files);
    });
    return () => {
      unBatch();
      unDrop();
    };
  }, []);

  // A 1 s clock for the ETA while converting.
  useEffect(() => {
    if (!s.converting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [s.converting]);

  async function pickFolder() {
    setUiError(null);
    setScanning(true);
    try {
      const res = await engine.pickFolder(s.recursive);
      if (res) s.setFolder(res.folder, res.files);
    } catch (e) {
      setUiError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function toggleRecursive(recursive: boolean) {
    s.setRecursive(recursive);
    if (!s.folder) return;
    setScanning(true);
    try {
      s.setFolder(s.folder, await engine.scanFolder(s.folder, recursive));
    } catch (e) {
      setUiError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function pickFiles() {
    setUiError(null);
    setScanning(true);
    try {
      const files = await engine.pickFiles();
      if (files.length > 0) s.addFiles(files);
    } catch (e) {
      setUiError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function pickOutDir() {
    const dir = await engine.pickOutDir();
    if (dir) s.setOutDir(dir);
  }

  async function convert() {
    setUiError(null);
    s.startBatch();
    try {
      await engine.startBatch(
        s.files.map((f) => ({
          path: f.path,
          duration: f.duration,
          trims: f.trims,
          audio: f.audio,
          audioSource: f.audioSource,
          normalize: f.normalize,
          audioTracks: f.audioTracks,
        })),
        {
          preset: resolvePreset(s.preset, s.customPresets),
          outDir: engine.caps.outputFolder ? s.outDir : null,
          parallel: engine.caps.advancedEncode ? s.parallel : 1,
          overwrite: s.overwrite,
          encoder: engine.caps.advancedEncode ? s.encoder : null,
          extraArgs: s.extraArgs.trim() ? s.extraArgs.trim().split(/\s+/) : [],
        },
      );
    } catch (e) {
      setUiError(String(e));
      s.batchDone({ converted: 0, failed: 0, skipped: 0, canceled: true });
    }
  }

  function addDraftPreset() {
    const name = draft.name.trim();
    if (!name || BUILTIN_PRESETS.some((p) => p.name === name)) return;
    s.addCustomPreset({ ...draft, name });
    setDraft({ ...draft, name: "" });
  }

  const hasQueue = s.folder !== null || s.files.length > 0;
  const total = s.files.length;
  const finished = s.files.filter((f) => ["done", "failed", "skipped"].includes(f.status)).length;
  const runningPct = s.files
    .filter((f) => f.status === "running")
    .reduce((a, f) => a + f.percent / 100, 0);
  const overall = total ? ((finished + runningPct) / total) * 100 : 0;
  const elapsed = s.batchStartedAt ? (now - s.batchStartedAt) / 1000 : 0;
  const eta = overall >= 3 && elapsed > 2 ? (elapsed * (100 - overall)) / overall : null;
  const doneFiles = s.files.filter((f) => f.status === "done" && f.outputs.length > 0);
  const savedIn = doneFiles.reduce((a, f) => a + f.size, 0);
  const savedOut = doneFiles.reduce((a, f) => a + f.outputs.reduce((x, o) => x + o.size, 0), 0);
  const outLabel =
    engine.caps.outputFolder && s.outDir
      ? (s.outDir.split(/[\\/]/).filter(Boolean).pop() ?? s.outDir)
      : `whatsapp_${slug(s.preset)}`;
  // Ceiling estimate: video maxrate + ~160 kbps AAC over the encoded seconds.
  const totalSecs = s.files.reduce((a, f) => a + effectiveSecs(f), 0);
  const estimateBytes = (kbps: number) => ((kbps + 160) * 1000 * totalSecs) / 8;
  const cards: { spec: PresetSpec; hint: string; custom: boolean }[] = [
    ...BUILTIN_PRESETS.map((spec) => ({ spec, hint: t(BUILTIN_HINTS[spec.name]), custom: false })),
    ...s.customPresets.map((c) => ({
      spec: customToSpec(c),
      hint: `${c.height}p · CRF ${c.crf} · ${c.maxrateKbps} kbps`,
      custom: true,
    })),
  ];
  const cores = Math.max(1, navigator.hardwareConcurrency || 4);
  const exts = VIDEO_EXTENSIONS.map((e) => `.${e}`).join(" ");

  const recursiveToggle = engine.caps.folders && (
    <label className="flex items-center gap-1.5 text-xs text-slate-400">
      <input
        type="checkbox"
        checked={s.recursive}
        disabled={s.converting || scanning}
        onChange={(e) => void toggleRecursive(e.target.checked)}
        className="accent-emerald-500"
      />
      {t("includeSubfolders")}
    </label>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-6 py-8">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Kecilin<span className="text-emerald-500">.</span>
            </h1>
            <p className="text-sm text-slate-400">{t("tagline")}</p>
          </div>
          {hasQueue && !s.converting && (
            <div className="flex gap-4 text-sm">
              <button onClick={pickFiles} disabled={scanning} className="text-emerald-400 hover:text-emerald-300">
                {t("addFiles")}
              </button>
              {engine.caps.folders && (
                <button onClick={pickFolder} disabled={scanning} className="text-emerald-400 hover:text-emerald-300">
                  {scanning ? t("scanning") : s.folder ? t("changeFolder") : t("scanFolder")}
                </button>
              )}
              {s.files.length > 0 && (
                <button onClick={() => s.clearQueue()} className="text-slate-500 hover:text-slate-300">
                  {t("clearQueue")}
                </button>
              )}
            </div>
          )}
        </header>

        {IS_WEB && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-xs text-slate-400">
            {t("webBanner")}{" "}
            <button onClick={() => engine.openReleases()} className="text-emerald-400 hover:text-emerald-300">
              {t("webBannerLink")}
            </button>{" "}
            {t("webBannerTail")}
          </div>
        )}

        {s.ffmpegError && (
          <div className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
            <b>{IS_WEB ? t("ffmpegBrokenWeb") : t("ffmpegBroken")}</b> {s.ffmpegError}
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
              onClick={engine.caps.folders ? pickFolder : pickFiles}
              disabled={scanning}
              className="rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/50 px-6 py-14 text-lg font-medium hover:border-emerald-600 hover:bg-slate-900 disabled:opacity-60"
            >
              {scanning ? t("scanning") : engine.caps.folders ? t("chooseFolder") : t("chooseVideos")}
              <span className="mt-2 block text-sm font-normal text-slate-400">
                {engine.caps.folders
                  ? t(s.recursive ? "scansForDeep" : "scansFor", { exts })
                  : t("takes", { exts })}
              </span>
            </button>
            <div className="flex items-center justify-center gap-6">
              <button onClick={pickFiles} disabled={scanning} className="text-sm text-emerald-400 hover:text-emerald-300 disabled:opacity-60">
                {t("orPick")}
              </button>
              {recursiveToggle}
            </div>
          </div>
        ) : (
          <>
            {s.folder && (
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1 truncate text-xs text-slate-500" title={s.folder}>
                  {s.folder}
                </div>
                {recursiveToggle}
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              {cards.map(({ spec, hint, custom }) => {
                const est = estimateBytes(maxrateKbps(spec));
                return (
                  <button
                    key={spec.name}
                    disabled={s.converting}
                    onClick={() => s.setPreset(spec.name)}
                    className={`rounded-xl border px-4 py-3 text-left transition ${
                      s.preset === spec.name
                        ? "border-emerald-500 bg-emerald-500/10"
                        : "border-slate-800 bg-slate-900 hover:border-slate-600"
                    } disabled:opacity-60`}
                  >
                    <div className="font-semibold">
                      {spec.name}
                      {custom && <span className="ml-1.5 text-[10px] uppercase text-slate-500">{t("custom")}</span>}
                    </div>
                    <div className="text-xs text-slate-400">{hint}</div>
                    {totalSecs > 0 && (
                      <div className="mt-1 text-[11px] text-slate-500" title={t("estimateTitle")}>
                        ≤ ~{fmtSize(est)}
                        {est <= 64 * 1024 * 1024 && <span className="text-emerald-500"> · {t("fits64")}</span>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {!engine.caps.outputFolder && <div className="text-xs text-slate-500">{t("outputWeb")}</div>}
            {engine.caps.outputFolder && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="shrink-0">{t("outputLabel")}</span>
                <span className="min-w-0 truncate" title={s.outDir ?? undefined}>
                  {s.outDir ?? t("outputDefault", { preset: slug(s.preset) })}
                </span>
                {!s.converting && (
                  <>
                    <button onClick={pickOutDir} className="shrink-0 text-emerald-400 hover:text-emerald-300">
                      {t("change")}
                    </button>
                    {s.outDir && (
                      <button onClick={() => s.setOutDir(null)} className="shrink-0 text-slate-500 hover:text-slate-300">
                        {t("reset")}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="rounded-xl border border-slate-800 bg-slate-900/60">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex w-full items-center justify-between px-4 py-2 text-xs text-slate-400 hover:text-slate-200"
              >
                <span>{t("advanced")}</span>
                <span>{showAdvanced ? "▾" : "▸"}</span>
              </button>
              {showAdvanced && (
                <div className="flex flex-col gap-4 border-t border-slate-800 px-4 py-4 text-sm">
                  {engine.caps.advancedEncode && (
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-300">{t("parallelLabel")}</span>
                      <div className="flex items-center gap-3">
                        <select
                          value={s.parallel}
                          disabled={s.converting}
                          onChange={(e) => s.setParallel(Number(e.target.value))}
                          className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                        >
                          {Array.from({ length: cores }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        <span className="text-xs text-slate-500">{t("parallelHint")}</span>
                      </div>
                    </label>
                  )}
                  {engine.caps.outputFolder && (
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-300">{t("overwriteLabel")}</span>
                      <select
                        value={s.overwrite}
                        disabled={s.converting}
                        onChange={(e) => s.setOverwrite(e.target.value as Overwrite)}
                        className="w-fit rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                      >
                        <option value="overwrite">{t("overwriteOverwrite")}</option>
                        <option value="skip">{t("overwriteSkip")}</option>
                        <option value="rename">{t("overwriteRename")}</option>
                      </select>
                    </label>
                  )}
                  {engine.caps.advancedEncode && (
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-300">{t("encoderLabel")}</span>
                      <div className="flex items-center gap-3">
                        <select
                          value={s.encoder ?? "cpu"}
                          disabled={s.converting}
                          onChange={(e) => s.setEncoder(e.target.value === "cpu" ? null : e.target.value)}
                          className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                        >
                          <option value="cpu">{t("encoderCpu")}</option>
                          {encoders.map((id) => (
                            <option key={id} value={id}>{ENCODER_NAMES[id] ?? id}</option>
                          ))}
                        </select>
                        <span className="text-xs text-slate-500">{t("encoderHint")}</span>
                      </div>
                    </label>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-300">{t("extraArgsLabel")}</span>
                    <input
                      value={s.extraArgs}
                      disabled={s.converting}
                      onChange={(e) => s.setExtraArgs(e.target.value)}
                      placeholder="-metadata title=Kecilin"
                      className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs"
                    />
                    <span className="text-xs text-slate-500">{t("extraArgsHint")}</span>
                  </label>
                  <div className="flex flex-col gap-2">
                    <span className="text-slate-300">{t("customPresets")}</span>
                    {s.customPresets.map((c) => (
                      <div key={c.name} className="flex items-center gap-3 text-xs text-slate-400">
                        <span className="font-medium text-slate-200">{c.name}</span>
                        <span>{c.height}p · CRF {c.crf} · {c.maxrateKbps} kbps · L{c.level}</span>
                        <button onClick={() => s.removeCustomPreset(c.name)} disabled={s.converting} className="ml-auto text-slate-500 hover:text-red-400">
                          {t("remove")}
                        </button>
                      </div>
                    ))}
                    <div className="flex flex-wrap items-end gap-2 text-xs">
                      {(
                        [
                          ["presetName", "name", "text"],
                          ["height", "height", "number"],
                          ["crf", "crf", "number"],
                          ["maxKbps", "maxrateKbps", "number"],
                        ] as const
                      ).map(([label, field, type]) => (
                        <label key={field} className="flex flex-col gap-1">
                          <span className="text-slate-500">{t(label)}</span>
                          <input
                            type={type}
                            value={draft[field]}
                            onChange={(e) =>
                              setDraft({ ...draft, [field]: type === "number" ? Number(e.target.value) : e.target.value })
                            }
                            className={`rounded-md border border-slate-700 bg-slate-950 px-2 py-1 ${type === "number" ? "w-20" : "w-32"}`}
                          />
                        </label>
                      ))}
                      <label className="flex flex-col gap-1">
                        <span className="text-slate-500">{t("level")}</span>
                        <select
                          value={draft.level}
                          onChange={(e) => setDraft({ ...draft, level: e.target.value })}
                          className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                        >
                          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </label>
                      <button
                        onClick={addDraftPreset}
                        disabled={!draft.name.trim() || draft.height < 144 || draft.maxrateKbps < 100}
                        className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
                      >
                        {t("addPreset")}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {s.files.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-8 text-center text-sm text-slate-400">
                {t("noVideos")}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {s.files.map((f, i) => (
                  <FileRow key={f.path} file={f} index={i} converting={s.converting} />
                ))}
              </div>
            )}

            {!s.converting && s.files.length > 0 && (
              <button
                onClick={convert}
                disabled={!!s.ffmpegError}
                className="rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {total === 1 ? t("convertOne", { out: outLabel }) : t("convertMany", { n: total, out: outLabel })}
              </button>
            )}

            {s.converting && (
              <div className="flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${overall}%` }} />
                </div>
                <span className="text-sm tabular-nums text-slate-300">
                  {finished}/{total}
                  {eta != null && <span className="text-slate-500"> · {t("etaLeft", { t: fmtEta(eta) })}</span>}
                </span>
                <button
                  onClick={() => engine.cancelBatch()}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
                >
                  {t("cancel")}
                </button>
              </div>
            )}

            {s.summary && !s.converting && (
              <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm">
                <span>
                  {s.summary.canceled && <span className="text-amber-400">{t("canceledPrefix")}</span>}
                  {t("converted", { n: s.summary.converted })}
                  {s.summary.failed > 0 && <span className="text-red-400">{t("failedN", { n: s.summary.failed })}</span>}
                  {s.summary.skipped > 0 && <span className="text-amber-400">{t("skippedN", { n: s.summary.skipped })}</span>}
                  {savedOut > 0 && savedIn > savedOut && (
                    <span className="text-slate-400">
                      {" "}
                      {t("saved", {
                        size: fmtSize(savedIn - savedOut),
                        pct: Math.round(((savedIn - savedOut) / savedIn) * 100),
                      })}
                    </span>
                  )}
                </span>
                {engine.caps.outputFolder && doneFiles.length > 0 && (
                  <button
                    onClick={() => engine.openOutputFolder(doneFiles[0].path, s.batchPreset, s.batchOutDir)}
                    className="font-medium text-emerald-400 hover:text-emerald-300"
                  >
                    {t("openOutput")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <footer className="flex items-center justify-center gap-3 pb-4 text-xs text-slate-600">
        <span>
          Kecilin {version && `v${version}`}
          {IS_WEB && " (web)"}
        </span>
        <span>·</span>
        <button onClick={() => engine.openReleases()} className="hover:text-slate-400">
          {t("releases")}
        </button>
        <span>·</span>
        {(["en", "id"] as const).map((l) => (
          <button
            key={l}
            onClick={() => s.setLang(l)}
            className={l === s.lang ? "text-slate-300" : "hover:text-slate-400"}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </footer>
    </div>
  );
}
