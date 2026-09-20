import { useEffect, useRef, useState } from "react";
import { engine } from "./engine";
import { calculateEffectiveDuration, outputName, solveSpeedMultiplier } from "./engine/args";
import { fmtSize, fmtTime, parseTime } from "./format";
import { useT } from "./i18n";
import { useStore } from "./store";
import type { AudioOpt, FileState, SpeedRange, Trim } from "./store";

// Thumbnails are extracted one at a time — each is an ffmpeg spawn.
let thumbQueue: Promise<void> = Promise.resolve();

export function FileRow({
  file,
  index,
  converting,
}: {
  file: FileState;
  index: number;
  converting: boolean;
}) {
  const t = useT();
  const removeFile = useStore((st) => st.removeFile);
  const [editing, setEditing] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbRaw, setThumbRaw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    thumbQueue = thumbQueue.then(async () => {
      if (!live) return;
      try {
        const th = await engine.prepareThumbnail(file.path, file.duration);
        if (live) {
          setThumbRaw(th.iconPath);
          setThumb(th.url);
        }
      } catch {
        // no thumbnail — the placeholder stays
      }
    });
    return () => {
      live = false;
    };
  }, [file.path, file.duration]);

  const done = file.status === "done" && file.outputs.length > 0;
  const outSum = file.outputs.reduce((a, o) => a + o.size, 0);
  const savedPct =
    done && file.size > 0 && outSum < file.size
      ? Math.round(((file.size - outSum) / file.size) * 100)
      : null;

  const badge = {
    queued: converting ? <span className="text-xs text-slate-500">{t("queued")}</span> : null,
    running: (
      <span className="text-xs tabular-nums text-emerald-400">{Math.round(file.percent)}%</span>
    ),
    done: (
      <span className="text-xs tabular-nums text-emerald-400" title={`${fmtSize(file.size)} → ${fmtSize(outSum)}`}>
        ✓ {savedPct != null ? `−${savedPct}%` : fmtSize(outSum)}
      </span>
    ),
    failed: (
      <span className="text-xs text-red-400" title={file.error ?? undefined}>
        {t("failed")}
      </span>
    ),
    canceled: <span className="text-xs text-amber-400">{t("canceled")}</span>,
    skipped: (
      <span className="text-xs text-amber-400" title={file.error ?? undefined}>
        {t("skipped")}
      </span>
    ),
  }[file.status];

  const trimBadge =
    file.trims.length === 1 ? (
      <span className="text-emerald-400">
        {" "}· ✂ {fmtTime(file.trims[0].start)}–{fmtTime(file.trims[0].end)}
        {file.trims[0].customName ? ` [${file.trims[0].customName}]` : ""}
      </span>
    ) : file.trims.length > 1 ? (
      <span className="text-emerald-400"> · ✂ {t("parts", { n: file.trims.length })}</span>
    ) : null;

  const speedBadge =
    file.speedRange && file.speedRange.speed > 1.0 ? (
      <span className="text-amber-400"> · ⚡ {file.speedRange.speed.toFixed(1)}x</span>
    ) : null;

  const audioNotes = [
    file.audioSource === "merge"
      ? t("mergedAudio")
      : typeof file.audioSource === "number"
        ? t("track", { n: file.audioSource + 1 })
        : null,
    file.normalize ? t("normalized") : null,
    file.audio === "mute" ? t("muted") : file.audio !== "keep" ? t("vol", { n: file.audio }) : null,
  ].filter(Boolean);
  const audioBadge =
    audioNotes.length > 0 ? <span className="text-amber-400"> · {audioNotes.join(" · ")}</span> : null;

  async function copyOutputs() {
    try {
      await engine.copyFiles(file.outputs.map((o) => o.path));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard busy — ignore
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setEditing(!editing)}
          disabled={converting}
          title={t("previewTrim") + (done && engine.caps.dragOut ? t("dragHint") : "")}
          draggable={done && engine.caps.dragOut && thumbRaw != null}
          onDragStart={(e) => {
            e.preventDefault();
            if (done && engine.caps.dragOut && thumbRaw) {
              engine.dragOut(file.outputs.map((o) => o.path), thumbRaw);
            }
          }}
          className="h-10 w-[71px] shrink-0 overflow-hidden rounded-md bg-slate-950 disabled:opacity-60"
        >
          {thumb ? (
            <img src={thumb} alt="" className="pointer-events-none h-full w-full object-cover" />
          ) : (
            <span className="flex h-full items-center justify-center text-slate-600">▶</span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={file.path}>
            {file.name}
          </div>
          <div className="text-xs text-slate-400">
            {fmtSize(file.size)}
            {file.duration != null && <> · {fmtTime(file.duration)}</>}
            {trimBadge}
            {speedBadge}
            {audioBadge}
          </div>
        </div>
        {badge}
        {file.status === "running" && (
          <button
            onClick={() => engine.skipFile(index)}
            title={t("skipFile")}
            className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs hover:bg-slate-800"
          >
            {t("skip")}
          </button>
        )}
        {done && !converting && (
          <>
            {engine.caps.reveal && (
              <button
                onClick={() => engine.revealFile(file.outputs[0].path)}
                title={t("showTitle")}
                className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs hover:bg-slate-800"
              >
                {t("show")}
              </button>
            )}
            {engine.caps.clipboard && (
              <button
                onClick={copyOutputs}
                title={t("copyTitle")}
                className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs hover:bg-slate-800"
              >
                {copied ? t("copied") : t("copy")}
              </button>
            )}
            {engine.caps.downloads &&
              file.outputs.map((o, i) => (
                <a
                  key={o.path}
                  href={o.path}
                  download={o.name ?? `${file.name}.mp4`}
                  className="rounded-lg border border-emerald-700 px-2.5 py-1.5 text-xs text-emerald-300 hover:bg-slate-800"
                >
                  {t("save")}{file.outputs.length > 1 ? ` ${i + 1}` : ""}
                </a>
              ))}
          </>
        )}
        <button
          disabled={converting}
          onClick={() => setEditing(!editing)}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40"
        >
          {file.trims.length > 0 ? t("editTrim") : t("trim")}
        </button>
        <button
          disabled={converting}
          onClick={() => removeFile(file.path)}
          title={t("removeFromQueue")}
          className="px-1 text-slate-600 hover:text-red-400 disabled:opacity-40"
        >
          ✕
        </button>
      </div>
      {file.status === "running" && (
        <div className="mx-4 -mt-1 mb-3 h-1 overflow-hidden rounded bg-slate-800">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${file.percent}%` }} />
        </div>
      )}
      {editing && !converting && (
        <TrimEditor file={file} index={index} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

function TrimEditor({
  file,
  index,
  onClose,
}: {
  file: FileState;
  index: number;
  onClose: () => void;
}) {
  const t = useT();
  const setTrims = useStore((st) => st.setTrims);
  const setAudio = useStore((st) => st.setAudio);
  const setAudioSource = useStore((st) => st.setAudioSource);
  const setNormalize = useStore((st) => st.setNormalize);
  const setSpeedRange = useStore((st) => st.setSpeedRange);
  const setTrimCustomName = useStore((st) => st.setTrimCustomName);
  const lastCustomLen = useStore((st) => st.lastCustomLen);
  const setLastCustomLen = useStore((st) => st.setLastCustomLen);
  const preset = useStore((st) => st.preset);
  const namingPattern = useStore((st) => st.namingPattern);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Native playback first; when the webview can't decode the file (HEVC
  // without the Windows codec, .mkv/.avi, …) fall back to a small H.264 proxy
  // re-encoded by the bundled ffmpeg. "none" only if even that fails.
  const [src, setSrc] = useState(() => engine.mediaSrc(file.path));
  const [preview, setPreview] = useState<"native" | "preparing" | "proxy" | "none">("native");
  const [proxyProgress, setProxyProgress] = useState(0);
  const triedProxy = useRef(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;

  useEffect(() => {
    return () => {
      if (previewRef.current === "preparing") {
        void engine.cancelPreviewProxy?.(file.path);
      }
    };
  }, [file.path]);

  function handleClose() {
    if (previewRef.current === "preparing") {
      void engine.cancelPreviewProxy?.(file.path);
    }
    onClose();
  }

  async function handleCancelProxy() {
    setPreview("none");
    try {
      await engine.cancelPreviewProxy?.(file.path);
    } catch {
      // ignore
    }
  }

  const [duration, setDuration] = useState<number | null>(file.duration);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [ranges, setRanges] = useState<Trim[]>(file.trims);
  const [lenMode, setLenMode] = useState<"free" | "30" | "custom">("free");
  const [customLen, setCustomLen] = useState(String(lastCustomLen || 15));

  const last = file.trims[file.trims.length - 1];
  const initStart = last?.start ?? 0;
  const initEnd = last?.end ?? file.duration ?? 0;
  const [start, setStart] = useState(initStart);
  const [end, setEnd] = useState(initEnd);
  const [startText, setStartText] = useState(fmtTime(initStart));
  const [endText, setEndText] = useState(fmtTime(initEnd));

  const [singleCustomName, setSingleCustomName] = useState<string>(
    file.trims[0]?.customName ?? "",
  );

  // Speed Ramp state
  const [speedRampEnabled, setSpeedRampEnabled] = useState<boolean>(file.speedRange != null);
  const [speedStart, setSpeedStart] = useState<number>(file.speedRange?.start ?? initStart);
  const [speedEnd, setSpeedEnd] = useState<number>(file.speedRange?.end ?? initEnd);
  const [speedStartText, setSpeedStartText] = useState<string>(fmtTime(file.speedRange?.start ?? initStart));
  const [speedEndText, setSpeedEndText] = useState<string>(fmtTime(file.speedRange?.end ?? initEnd));
  const [speedMode, setSpeedMode] = useState<"fixed" | "target">(
    file.speedRange?.fitTarget ? "target" : "fixed",
  );
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(file.speedRange?.speed ?? 2);
  const [customSpeedMult, setCustomSpeedMult] = useState<string>(
    file.speedRange?.speed && ![1.5, 2, 4, 8].includes(file.speedRange.speed)
      ? String(file.speedRange.speed)
      : "",
  );
  const [targetDurationInput, setTargetDurationInput] = useState<string>(
    file.speedRange?.targetDuration ? String(file.speedRange.targetDuration) : "30",
  );

  const showVideo = preview === "native" || preview === "proxy";
  const customSecs = parseFloat(customLen);
  const fixedLen =
    lenMode === "30" ? 30 : lenMode === "custom" && customSecs >= 1 ? customSecs : null;

  async function fallbackToProxy() {
    if (triedProxy.current) {
      setPreview("none");
      return;
    }
    triedProxy.current = true;
    setProxyProgress(0);
    setPreview("preparing");
    try {
      const proxySrc = await engine.preparePreviewProxy(file.path, (pct) => {
        setProxyProgress(pct);
      });
      if (previewRef.current === "preparing") {
        setSrc(proxySrc);
        setPreview("proxy");
      }
    } catch {
      if (previewRef.current === "preparing") {
        setPreview("none");
      }
    }
  }

  function update(ns: number, ne: number, scrubTo?: number) {
    setStart(ns);
    setEnd(ne);
    setStartText(fmtTime(ns));
    setEndText(fmtTime(ne));
    const v = videoRef.current;
    if (v && scrubTo != null && showVideo) v.currentTime = scrubTo;
  }

  /** Fixed-length mode: the window keeps length L and slides to `sRaw`. */
  function slideTo(sRaw: number, L: number) {
    const d = duration ?? sRaw + L;
    const len = Math.min(L, d);
    const ns = Math.min(Math.max(0, sRaw), Math.max(0, d - len));
    update(ns, Math.min(ns + len, d), ns);
  }

  function handleRange(ns: number, ne: number, moved: "start" | "end") {
    if (fixedLen != null && duration != null) {
      slideTo(moved === "start" ? ns : ne - fixedLen, fixedLen);
    } else {
      update(ns, ne, moved === "start" ? ns : ne);
    }
  }

  function commitText(which: "start" | "end", text: string) {
    const v = parseTime(text);
    if (v == null) {
      setStartText(fmtTime(start));
      setEndText(fmtTime(end));
      return;
    }
    const max = duration ?? Number.POSITIVE_INFINITY;
    if (which === "start") handleRange(Math.min(Math.max(0, v), end - 0.1), end, "start");
    else handleRange(start, Math.min(Math.max(v, start + 0.1), max), "end");
  }

  function commitSpeedText(which: "start" | "end", text: string) {
    const v = parseTime(text);
    if (v == null) {
      setSpeedStartText(fmtTime(speedStart));
      setSpeedEndText(fmtTime(speedEnd));
      return;
    }
    const max = duration ?? Number.POSITIVE_INFINITY;
    if (which === "start") {
      const ns = Math.max(0, Math.min(Math.max(0, v), speedEnd - 0.1));
      setSpeedStart(ns);
      setSpeedStartText(fmtTime(ns));
    } else {
      const ne = Math.min(Math.max(v, speedStart + 0.1), max);
      setSpeedEnd(ne);
      setSpeedEndText(fmtTime(ne));
    }
  }

  function commitCustomLen(valStr: string) {
    const val = parseFloat(valStr);
    if (Number.isFinite(val) && val >= 1) {
      setLastCustomLen(val);
      slideTo(start, val);
    }
  }

  function stepFrame(frames: number) {
    const v = videoRef.current;
    if (!v || !showVideo) return;
    if (!v.paused) v.pause();
    const step = frames * (1 / 30);
    const cur = v.currentTime;
    const max = duration ?? v.duration ?? Number.POSITIVE_INFINITY;
    const next = Math.max(0, Math.min(max, cur + step));
    v.currentTime = next;
    setPlayhead(next);
  }

  const valid = end > start + 0.05;

  function autoSplit() {
    if (!duration || duration <= 0) return;
    const L =
      lenMode === "30" ? 30 : customSecs >= 1 ? customSecs : lastCustomLen || 15;
    const slices: Trim[] = [];
    for (let s = 0; s < duration; s += L) {
      slices.push({
        start: s,
        end: Math.min(s + L, duration),
      });
    }
    setRanges(slices);
  }

  function addPart() {
    if (!valid) return;
    const added: Trim = {
      start,
      end,
      customName:
        ranges.length === 0 && singleCustomName.trim() ? singleCustomName.trim() : undefined,
    };
    setRanges([...ranges, added]);
    if (ranges.length === 0) {
      setSingleCustomName("");
    }
    // Fixed-length flow: advance the window to right after the added part, so
    // stamping consecutive Status parts is just Add, Add, Add.
    if (fixedLen != null && duration != null && added.end < duration - 0.05) {
      slideTo(added.end, fixedLen);
    }
  }

  // Active trim interval for speed calculations
  const activeTrim =
    ranges.length === 1
      ? { start: ranges[0].start, end: ranges[0].end }
      : ranges.length === 0
        ? start <= 0.05 && duration != null && end >= duration - 0.05
          ? null
          : { start, end }
        : null;

  const targetSeconds = parseFloat(targetDurationInput) || 30;

  const effectiveSpeed: number =
    speedMode === "target"
      ? Number(
          solveSpeedMultiplier(
            targetSeconds,
            duration ?? end,
            activeTrim,
            speedStart,
            speedEnd,
          ).toFixed(2),
        )
      : speedMultiplier;

  const currentSpeedRange: SpeedRange | null = speedRampEnabled
    ? {
        start: speedStart,
        end: speedEnd,
        speed: effectiveSpeed,
        fitTarget: speedMode === "target",
        targetDuration: speedMode === "target" ? targetSeconds : undefined,
      }
    : null;

  const totalDur = duration ?? end;
  const origDur = activeTrim ? activeTrim.end - activeTrim.start : totalDur;
  const effDur = calculateEffectiveDuration(totalDur, activeTrim, currentSpeedRange);
  const savedSecs = Math.max(0, origDur - effDur);

  function apply() {
    let out = ranges;
    if (out.length === 0) {
      const full =
        start <= 0.05 &&
        duration != null &&
        end >= duration - 0.05 &&
        !singleCustomName.trim();
      out = full ? [] : [{ start, end, customName: singleCustomName.trim() || undefined }];
    }
    setTrims(file.path, out);
    setSpeedRange(index, currentSpeedRange);
    handleClose();
  }

  function clearAll() {
    setTrims(file.path, []);
    setSpeedRange(index, null);
    setSingleCustomName("");
    setSpeedRampEnabled(false);
    handleClose();
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v || !showVideo) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    // Resume from where it paused/seeked; restart when outside the range.
    if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
    v.play();
  }

  // Space toggles play/pause while the editor is open (unless typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
      e.preventDefault();
      togglePlay();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex flex-col gap-3 border-t border-slate-800 px-4 py-4">
      {showVideo && (
        <video
          key={src}
          ref={videoRef}
          src={src}
          className="max-h-64 w-full rounded-lg bg-black"
          onError={() => void fallbackToProxy()}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (Number.isFinite(v.duration)) {
              setDuration((d) => d ?? v.duration);
              if (end <= 0) update(start, v.duration);
              if (speedEnd <= 0) {
                setSpeedEnd(v.duration);
                setSpeedEndText(fmtTime(v.duration));
              }
            }
            // Audio decodes but the video track can't: no error fires and
            // videoWidth stays 0 — switch to the ffmpeg proxy.
            if (v.videoWidth === 0) void fallbackToProxy();
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setPlayhead(v.currentTime);
            // Auto-pause when playback crosses the range end (but let seeks
            // beyond it play freely — "start from the middle" is allowed).
            if (!v.paused && v.currentTime >= end && v.currentTime < end + 0.5) v.pause();
          }}
        />
      )}
      {preview === "preparing" && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-300">
              {t("preparingPreview")}
            </span>
            <button
              type="button"
              onClick={handleCancelProxy}
              className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-white transition-colors"
            >
              {t("cancelPreview")}
            </button>
          </div>
          <div className="mt-2.5 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-emerald-500 transition-all duration-200 ease-out"
                style={{ width: `${proxyProgress}%` }}
              />
            </div>
            <span className="w-9 text-right text-xs font-mono text-emerald-400">
              {proxyProgress}%
            </span>
          </div>
        </div>
      )}
      {preview === "none" && <p className="text-xs text-slate-400">{t("noPreview")}</p>}

      {/* Part length and Auto-Split toolbar */}
      {duration != null && duration > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>{t("partLength")}</span>
          {(
            [
              ["free", t("free")],
              ["30", t("status30")],
              ["custom", t("customLen")],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => {
                setLenMode(mode);
                const L =
                  mode === "30"
                    ? 30
                    : mode === "custom"
                      ? customSecs >= 1
                        ? customSecs
                        : lastCustomLen || 15
                      : null;
                if (L != null && L >= 1) {
                  if (mode === "custom") {
                    setLastCustomLen(L);
                  }
                  slideTo(start, L);
                }
              }}
              className={`rounded-full border px-2.5 py-1 ${
                lenMode === mode
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-700 hover:bg-slate-800"
              }`}
            >
              {label}
            </button>
          ))}
          {lenMode === "custom" && (
            <label className="flex items-center gap-1">
              <input
                value={customLen}
                onChange={(e) => setCustomLen(e.target.value)}
                onBlur={(e) => commitCustomLen(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitCustomLen(customLen)}
                className="w-14 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums font-mono"
              />
              s
            </label>
          )}
          <button
            type="button"
            onClick={autoSplit}
            className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-amber-300 hover:bg-amber-500/20 hover:border-amber-400 font-medium transition-colors"
          >
            {t("autoSplitBtn", { len: lenMode === "30" ? "30s" : `${customLen}s` })}
          </button>
          {fixedLen != null && <span className="text-slate-500">{t("slideHint")}</span>}
        </div>
      )}

      {/* Multi-part cuts chip list with inline filename editing */}
      {ranges.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {ranges.map((r, i) => (
            <span
              key={`${r.start}-${r.end}-${i}`}
              className="flex items-center gap-1.5 rounded-full border border-emerald-700 bg-emerald-500/10 px-2.5 py-1 tabular-nums text-emerald-300"
            >
              <span>{t("partChip", { n: i + 1 })}</span>
              <input
                type="text"
                value={r.customName ?? ""}
                placeholder={outputName(file.path, preset, i + 1, namingPattern)}
                title={t("outputFilenamePlaceholder")}
                onChange={(e) => {
                  const val = e.target.value;
                  const updated = ranges.map((p, pi) =>
                    pi === i ? { ...p, customName: val || undefined } : p,
                  );
                  setRanges(updated);
                  setTrimCustomName(index, i, val);
                  if (i === 0) {
                    setSingleCustomName(val);
                  }
                }}
                className="w-28 rounded border border-emerald-700/60 bg-slate-950/80 px-1.5 py-0.5 text-xs text-emerald-200 placeholder:text-emerald-700/50 focus:border-emerald-400 focus:outline-none font-mono"
              />
              <span>{fmtTime(r.start)}–{fmtTime(r.end)}</span>
              <button
                onClick={() => {
                  const next = ranges.filter((_, j) => j !== i);
                  setRanges(next);
                  if (next.length === 0) {
                    setSingleCustomName("");
                  }
                }}
                className="text-emerald-400 hover:text-white ml-0.5"
                title={t("removePart")}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Precision Timeline Scrubber */}
      {duration != null && duration > 0 && (
        <RangeSlider
          duration={duration}
          start={start}
          end={end}
          playhead={showVideo ? playhead : null}
          speedRange={currentSpeedRange}
          onChange={handleRange}
          onSeek={(tt) => {
            const v = videoRef.current;
            if (v && showVideo) {
              v.currentTime = tt;
              setPlayhead(tt);
            }
          }}
          labels={[t("trimStart"), t("trimEnd")]}
        />
      )}

      {/* Speed Ramp (Fast Forward) Control Deck */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 cursor-pointer select-none font-medium text-xs text-amber-400">
            <input
              type="checkbox"
              checked={speedRampEnabled}
              onChange={(e) => {
                const checked = e.target.checked;
                setSpeedRampEnabled(checked);
                if (checked) {
                  const s = start;
                  const eVal = end > start ? end : (duration ?? 0);
                  setSpeedStart(s);
                  setSpeedEnd(eVal);
                  setSpeedStartText(fmtTime(s));
                  setSpeedEndText(fmtTime(eVal));
                }
              }}
              className="accent-amber-500 rounded"
            />
            <span>⚡ {t("speedRamp")}</span>
          </label>

          {speedRampEnabled && (
            <span className="text-xs text-slate-400 font-mono">
              {t("effectiveDurationLabel", {
                orig: fmtTime(origDur),
                out: fmtTime(effDur),
                saved: t("timeSaved", { t: fmtTime(savedSecs) }),
              })}
            </span>
          )}
        </div>

        {speedRampEnabled && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300 pt-1 border-t border-slate-800/80">
            <label className="flex items-center gap-1.5">
              <span>{t("from")}</span>
              <input
                value={speedStartText}
                onChange={(e) => setSpeedStartText(e.target.value)}
                onBlur={(e) => commitSpeedText("start", e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitSpeedText("start", speedStartText)}
                className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums font-mono"
              />
            </label>

            <label className="flex items-center gap-1.5">
              <span>{t("to")}</span>
              <input
                value={speedEndText}
                onChange={(e) => setSpeedEndText(e.target.value)}
                onBlur={(e) => commitSpeedText("end", e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitSpeedText("end", speedEndText)}
                className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums font-mono"
              />
            </label>

            <div className="flex items-center gap-1 bg-slate-900 rounded-md p-0.5 border border-slate-800">
              <button
                type="button"
                onClick={() => setSpeedMode("fixed")}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  speedMode === "fixed"
                    ? "bg-amber-500 text-slate-950 font-semibold shadow"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {t("speedMultiplier")}
              </button>
              <button
                type="button"
                onClick={() => setSpeedMode("target")}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  speedMode === "target"
                    ? "bg-amber-500 text-slate-950 font-semibold shadow"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {t("fitTargetDuration")}
              </button>
            </div>

            {speedMode === "fixed" && (
              <div className="flex items-center gap-1">
                {[1.5, 2, 4, 8].map((mult) => (
                  <button
                    key={mult}
                    type="button"
                    onClick={() => {
                      setSpeedMultiplier(mult);
                      setCustomSpeedMult("");
                    }}
                    className={`px-2 py-1 rounded border text-xs tabular-nums font-medium ${
                      speedMultiplier === mult && !customSpeedMult
                        ? "border-amber-500 bg-amber-500/20 text-amber-300"
                        : "border-slate-700 hover:bg-slate-800 text-slate-300"
                    }`}
                  >
                    {mult}x
                  </button>
                ))}
                <label className="flex items-center gap-1 ml-1 text-slate-400">
                  <input
                    type="text"
                    placeholder="custom"
                    value={customSpeedMult}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomSpeedMult(val);
                      const num = parseFloat(val);
                      if (Number.isFinite(num) && num >= 1) {
                        setSpeedMultiplier(num);
                      }
                    }}
                    className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-center text-xs tabular-nums font-mono text-slate-200"
                  />
                  <span>x</span>
                </label>
              </div>
            )}

            {speedMode === "target" && (
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-slate-400">
                  <span>{t("targetDurationLabel")}:</span>
                  <input
                    type="text"
                    value={targetDurationInput}
                    onChange={(e) => setTargetDurationInput(e.target.value)}
                    className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-center text-xs tabular-nums font-mono text-slate-200"
                  />
                  <span>s</span>
                </label>
                <span className="text-amber-400 font-mono font-medium">
                  → {effectiveSpeed}x
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main playback and single trim controls */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {showVideo && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={togglePlay}
              title={t("playTitle")}
              className="w-28 rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800 text-xs font-medium"
            >
              {playing ? t("pause") : t("playRange")}
            </button>
            <button
              type="button"
              onClick={() => stepFrame(-1)}
              title="-1 frame (~0.033s)"
              className="rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800 font-mono"
            >
              {t("frameStepBack")}
            </button>
            <button
              type="button"
              onClick={() => stepFrame(1)}
              title="+1 frame (~0.033s)"
              className="rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800 font-mono"
            >
              {t("frameStepFwd")}
            </button>
          </div>
        )}
        {showVideo && playhead != null && (
          <span className="tabular-nums text-xs text-slate-400">{t("at", { t: fmtTime(playhead) })}</span>
        )}
        <label className="flex items-center gap-1.5 text-slate-300">
          {t("from")}
          <input
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={(e) => commitText("start", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitText("start", startText)}
            className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums font-mono"
          />
        </label>
        <label className="flex items-center gap-1.5 text-slate-300">
          {t("to")}
          <input
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            onBlur={(e) => commitText("end", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitText("end", endText)}
            className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums font-mono"
          />
        </label>
        {file.audioTracks > 1 && (
          <label className="flex items-center gap-1.5 text-slate-300">
            {t("source")}
            <select
              value={String(file.audioSource)}
              onChange={(e) => {
                const v = e.target.value;
                setAudioSource(file.path, v === "default" || v === "merge" ? v : Number(v));
              }}
              title={t("sourceTitle")}
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
            >
              <option value="default">{t("trackDefault")}</option>
              {Array.from({ length: file.audioTracks - 1 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {t("trackN", { n: i + 2 })}
                </option>
              ))}
              <option value="merge">{t("mergeAll")}</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-slate-300">
          {t("audio")}
          <select
            value={file.audio}
            onChange={(e) => setAudio(file.path, e.target.value as AudioOpt)}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
          >
            <option value="keep">{t("keep")}</option>
            <option value="75">75%</option>
            <option value="50">50%</option>
            <option value="25">25%</option>
            <option value="mute">{t("mute")}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-slate-300 text-xs" title={t("normalizeTitle")}>
          <input
            type="checkbox"
            checked={file.normalize}
            onChange={(e) => setNormalize(file.path, e.target.checked)}
            className="accent-emerald-500"
          />
          {t("normalize")}
        </label>
        <span className="text-xs text-slate-500">
          {valid ? t("selected", { t: fmtTime(end - start) }) : t("endAfterStart")}
        </span>

        {/* Per-Trim Direct Filename Editor for single trim */}
        {ranges.length === 0 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-300" title={t("outputFilenamePlaceholder")}>
            <span className="text-slate-400 font-mono">📁</span>
            <input
              type="text"
              value={singleCustomName}
              placeholder={outputName(file.path, preset, null, namingPattern)}
              onChange={(e) => {
                const val = e.target.value;
                setSingleCustomName(val);
                setTrimCustomName(index, 0, val);
              }}
              className="w-44 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none font-mono"
            />
          </label>
        )}

        <div className="ml-auto flex gap-2">
          <button
            disabled={!valid}
            onClick={addPart}
            title={t("addPartTitle")}
            className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40 text-xs font-medium"
          >
            {t("addPart")}
          </button>
          {(ranges.length > 0 || file.trims.length > 0 || file.speedRange != null) && (
            <button
              onClick={clearAll}
              className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800 text-xs font-medium"
            >
              {t("clear")}
            </button>
          )}
          <button
            onClick={handleClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800 text-xs font-medium"
          >
            {t("cancel")}
          </button>
          <button
            disabled={!valid && ranges.length === 0}
            onClick={apply}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-40 text-xs"
          >
            {ranges.length > 0 ? t("applyParts", { n: ranges.length }) : t("apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

const MIN_GAP = 0.1;

function RangeSlider({
  duration,
  start,
  end,
  playhead,
  speedRange,
  onChange,
  onSeek,
  labels,
}: {
  duration: number;
  start: number;
  end: number;
  playhead?: number | null;
  speedRange?: SpeedRange | null;
  onChange: (start: number, end: number, moved: "start" | "end") => void;
  onSeek?: (t: number) => void;
  labels: [string, string];
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<"start" | "end" | "seek" | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  function timeAt(clientX: number): number {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  }

  const pct = (v: number) => (duration > 0 ? (v / duration) * 100 : 0);

  function nudge(which: "start" | "end", delta: number) {
    if (which === "start") onChange(Math.min(Math.max(0, start + delta), end - MIN_GAP), end, "start");
    else onChange(start, Math.max(Math.min(duration, end + delta), start + MIN_GAP), "end");
  }

  const needleTime = playhead != null ? playhead : isHovering || isDragging ? hoverTime : null;

  let tooltipVal: number | null = null;
  let tooltipLeftPct: number = 0;
  if (drag.current === "start") {
    tooltipVal = start;
    tooltipLeftPct = pct(start);
  } else if (drag.current === "end") {
    tooltipVal = end;
    tooltipLeftPct = pct(end);
  } else if (drag.current === "seek" || isHovering) {
    tooltipVal = hoverTime ?? playhead ?? 0;
    tooltipLeftPct = pct(tooltipVal);
  } else if (playhead != null) {
    tooltipVal = playhead;
    tooltipLeftPct = pct(playhead);
  }

  return (
    <div
      ref={trackRef}
      className="relative h-10 select-none touch-none flex items-center cursor-pointer"
      onPointerEnter={() => setIsHovering(true)}
      onPointerLeave={() => {
        setIsHovering(false);
        if (!drag.current) setHoverTime(null);
      }}
      onPointerDown={(ev) => {
        // Thumbs stop propagation — a press here is a seek on the timeline.
        drag.current = "seek";
        setIsDragging(true);
        (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
        const t = timeAt(ev.clientX);
        setHoverTime(t);
        onSeek?.(t);
      }}
      onPointerMove={(ev) => {
        const v = timeAt(ev.clientX);
        setHoverTime(v);
        if (!drag.current) return;
        if (drag.current === "seek") onSeek?.(v);
        else if (drag.current === "start") onChange(Math.min(v, end - MIN_GAP), end, "start");
        else onChange(start, Math.max(v, start + MIN_GAP), "end");
      }}
      onPointerUp={() => {
        drag.current = null;
        setIsDragging(false);
        setHoverTime(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setIsDragging(false);
        setHoverTime(null);
      }}
    >
      {/* 20px precision track bar */}
      <div className="relative h-5 w-full rounded-md bg-[#1e293b] border border-slate-700/60 overflow-hidden shadow-inner">
        {/* Active trim interval: glowing emerald #10b981 */}
        <div
          className="absolute top-0 bottom-0 bg-[#10b981] shadow-[0_0_12px_rgba(16,185,129,0.5)]"
          style={{ left: `${pct(start)}%`, width: `${Math.max(0, pct(end) - pct(start))}%` }}
        />

        {/* Speed ramp sub-interval: amber overlay #f59e0b with diagonal stripe pattern */}
        {speedRange && speedRange.end > speedRange.start && speedRange.speed > 1.0 && (
          <div
            className="absolute top-0 bottom-0 bg-[#f59e0b]/85 border-x border-[#f59e0b]"
            style={{
              left: `${pct(Math.max(0, speedRange.start))}%`,
              width: `${Math.max(
                0,
                pct(Math.min(duration, speedRange.end)) - pct(Math.max(0, speedRange.start)),
              )}%`,
              backgroundImage:
                "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0, 0, 0, 0.35) 4px, rgba(0, 0, 0, 0.35) 8px)",
            }}
            title={`⚡ ${speedRange.speed.toFixed(1)}x: ${fmtTime(speedRange.start)}–${fmtTime(speedRange.end)}`}
          />
        )}
      </div>

      {/* Playhead needle: laser cyan #38bdf8 vertical bar */}
      {needleTime != null && (
        <div
          className="pointer-events-none absolute -top-1 -bottom-1 w-[2px] -translate-x-1/2 bg-[#38bdf8] shadow-[0_0_8px_#38bdf8] z-20"
          style={{ left: `${pct(Math.min(duration, Math.max(0, needleTime)))}%` }}
        />
      )}

      {/* Time badge tooltip on hover/drag */}
      {(isHovering || isDragging) && tooltipVal != null && (
        <div
          className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-slate-900/95 border border-[#38bdf8]/60 px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-[#38bdf8] shadow-lg whitespace-nowrap z-40"
          style={{ left: `${Math.max(3, Math.min(97, tooltipLeftPct))}%` }}
        >
          {fmtTime(tooltipVal)}
        </div>
      )}

      {/* Thumbs: Ergonomic handles with accessible hit targets and keyboard arrow nudge support */}
      {(["start", "end"] as const).map((which, i) => (
        <div
          key={which}
          tabIndex={0}
          role="slider"
          aria-label={labels[i]}
          aria-valuenow={which === "start" ? start : end}
          onPointerDown={(ev) => {
            ev.stopPropagation();
            drag.current = which;
            (ev.target as Element).setPointerCapture(ev.pointerId);
            ev.preventDefault();
            setIsDragging(true);
          }}
          onPointerUp={() => {
            drag.current = null;
            setIsDragging(false);
          }}
          onKeyDown={(ev) => {
            // Arrow keys nudge the focused handle: 0.1 s, Shift = 1 s.
            const step = ev.shiftKey ? 1 : 0.1;
            if (ev.key === "ArrowLeft") nudge(which, -step);
            else if (ev.key === "ArrowRight") nudge(which, step);
            else return;
            ev.preventDefault();
          }}
          className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize z-30 flex items-center justify-center h-8 w-6 focus:outline-none"
          style={{ left: `${pct(which === "start" ? start : end)}%` }}
        >
          <div className="h-7 w-3.5 rounded-md bg-emerald-400 border border-white/70 shadow-[0_2px_6px_rgba(0,0,0,0.6)] group-hover:bg-emerald-300 group-hover:scale-105 group-focus:ring-2 group-focus:ring-white transition-all flex items-center justify-center">
            <div className="h-3 w-0.5 rounded-full bg-emerald-900/60" />
          </div>
        </div>
      ))}
    </div>
  );
}
