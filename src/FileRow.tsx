import { useEffect, useRef, useState } from "react";
import { engine } from "./engine";
import { fmtSize, fmtTime, parseTime } from "./format";
import { useStore } from "./store";
import type { AudioOpt, FileState, Trim } from "./store";

// Thumbnails are extracted one at a time — each is an ffmpeg spawn.
let thumbQueue: Promise<void> = Promise.resolve();

export function FileRow({ file, converting }: { file: FileState; converting: boolean }) {
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
        const t = await engine.prepareThumbnail(file.path, file.duration);
        if (live) {
          setThumbRaw(t.iconPath);
          setThumb(t.url);
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
    queued: converting ? <span className="text-xs text-slate-500">queued</span> : null,
    running: (
      <span className="text-xs tabular-nums text-emerald-400">{Math.round(file.percent)}%</span>
    ),
    done: (
      <span
        className="text-xs tabular-nums text-emerald-400"
        title={`${fmtSize(file.size)} → ${fmtSize(outSum)}`}
      >
        ✓ {savedPct != null ? `−${savedPct}%` : fmtSize(outSum)}
      </span>
    ),
    failed: (
      <span className="text-xs text-red-400" title={file.error ?? undefined}>
        ✗ failed
      </span>
    ),
    canceled: <span className="text-xs text-amber-400">canceled</span>,
  }[file.status];

  const trimBadge =
    file.trims.length === 1 ? (
      <span className="text-emerald-400">
        {" "}
        · ✂ {fmtTime(file.trims[0].start)}–{fmtTime(file.trims[0].end)}
      </span>
    ) : file.trims.length > 1 ? (
      <span className="text-emerald-400"> · ✂ {file.trims.length} parts</span>
    ) : null;

  const audioNotes = [
    file.audioSource === "merge"
      ? "merged audio"
      : typeof file.audioSource === "number"
        ? `track ${file.audioSource + 1}`
        : null,
    file.normalize ? "normalized" : null,
    file.audio === "mute" ? "muted" : file.audio !== "keep" ? `vol ${file.audio}%` : null,
  ].filter(Boolean);
  const audioBadge =
    audioNotes.length > 0 ? (
      <span className="text-amber-400"> · {audioNotes.join(" · ")}</span>
    ) : null;

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
          title={
            done && engine.caps.dragOut
              ? "Preview / trim — drag me to share the converted file"
              : "Preview / trim"
          }
          draggable={done && engine.caps.dragOut && thumbRaw != null}
          onDragStart={(e) => {
            e.preventDefault();
            if (done && engine.caps.dragOut && thumbRaw) {
              engine.dragOut(
                file.outputs.map((o) => o.path),
                thumbRaw,
              );
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
            {audioBadge}
          </div>
        </div>
        {badge}
        {done && !converting && (
          <>
            {engine.caps.reveal && (
              <button
                onClick={() => engine.revealFile(file.outputs[0].path)}
                title="Show the converted file in Explorer"
                className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs hover:bg-slate-800"
              >
                Show
              </button>
            )}
            {engine.caps.clipboard && (
              <button
                onClick={copyOutputs}
                title="Copy the converted file to the clipboard (Ctrl+V to paste)"
                className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs hover:bg-slate-800"
              >
                {copied ? "Copied ✓" : "Copy"}
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
                  Save{file.outputs.length > 1 ? ` ${i + 1}` : ""}
                </a>
              ))}
          </>
        )}
        <button
          disabled={converting}
          onClick={() => setEditing(!editing)}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40"
        >
          {file.trims.length > 0 ? "Edit trim" : "Trim"}
        </button>
        <button
          disabled={converting}
          onClick={() => removeFile(file.path)}
          title="Remove from queue"
          className="px-1 text-slate-600 hover:text-red-400 disabled:opacity-40"
        >
          ✕
        </button>
      </div>
      {file.status === "running" && (
        <div className="mx-4 -mt-1 mb-3 h-1 overflow-hidden rounded bg-slate-800">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${file.percent}%` }}
          />
        </div>
      )}
      {editing && !converting && <TrimEditor file={file} onClose={() => setEditing(false)} />}
    </div>
  );
}

function TrimEditor({ file, onClose }: { file: FileState; onClose: () => void }) {
  const setTrims = useStore((st) => st.setTrims);
  const setAudio = useStore((st) => st.setAudio);
  const setAudioSource = useStore((st) => st.setAudioSource);
  const setNormalize = useStore((st) => st.setNormalize);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Native playback first; when the webview can't decode the file (HEVC
  // without the Windows codec, .mkv/.avi, …) fall back to a small H.264 proxy
  // re-encoded by the bundled ffmpeg. "none" only if even that fails.
  const [src, setSrc] = useState(() => engine.mediaSrc(file.path));
  const [preview, setPreview] = useState<"native" | "preparing" | "proxy" | "none">("native");
  const triedProxy = useRef(false);
  const [duration, setDuration] = useState<number | null>(file.duration);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [ranges, setRanges] = useState<Trim[]>(file.trims);
  const [lenMode, setLenMode] = useState<"free" | "30" | "custom">("free");
  const [customLen, setCustomLen] = useState("15");
  const last = file.trims[file.trims.length - 1];
  const initStart = last?.start ?? 0;
  const initEnd = last?.end ?? file.duration ?? 0;
  const [start, setStart] = useState(initStart);
  const [end, setEnd] = useState(initEnd);
  const [startText, setStartText] = useState(fmtTime(initStart));
  const [endText, setEndText] = useState(fmtTime(initEnd));

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
    setPreview("preparing");
    try {
      setSrc(await engine.preparePreviewProxy(file.path));
      setPreview("proxy");
    } catch {
      setPreview("none");
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
    const t = parseTime(text);
    if (t == null) {
      setStartText(fmtTime(start));
      setEndText(fmtTime(end));
      return;
    }
    const max = duration ?? Number.POSITIVE_INFINITY;
    if (which === "start") handleRange(Math.min(Math.max(0, t), end - 0.1), end, "start");
    else handleRange(start, Math.min(Math.max(t, start + 0.1), max), "end");
  }

  const valid = end > start + 0.05;

  function addPart() {
    if (!valid) return;
    const added = { start, end };
    setRanges([...ranges, added]);
    // Fixed-length flow: advance the window to right after the added part, so
    // stamping consecutive Status parts is just Add, Add, Add.
    if (fixedLen != null && duration != null && added.end < duration - 0.05) {
      slideTo(added.end, fixedLen);
    }
  }

  function apply() {
    let out = ranges;
    if (out.length === 0) {
      const full = start <= 0.05 && duration != null && end >= duration - 0.05;
      out = full ? [] : [{ start, end }];
    }
    setTrims(file.path, out);
    onClose();
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
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(t.tagName)) return;
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
        <p className="text-xs text-slate-400">
          Preparing preview… (re-encoding a small proxy with the bundled ffmpeg — first time per
          file)
        </p>
      )}
      {preview === "none" && (
        <p className="text-xs text-slate-400">
          Preview couldn't be generated for this file — trim with the slider or typed times below;{" "}
          <b>conversion is unaffected</b>.
        </p>
      )}

      {duration != null && duration > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>Part length:</span>
          {(
            [
              ["free", "Free"],
              ["30", "30 s (Status)"],
              ["custom", "Custom"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => {
                setLenMode(mode);
                const L = mode === "30" ? 30 : mode === "custom" ? customSecs : null;
                if (L != null && L >= 1) slideTo(start, L);
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
                onBlur={() => customSecs >= 1 && slideTo(start, customSecs)}
                className="w-14 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums"
              />
              s
            </label>
          )}
          {fixedLen != null && (
            <span className="text-slate-500">— slide the window, then “+ Add part”</span>
          )}
        </div>
      )}

      {ranges.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {ranges.map((r, i) => (
            <span
              key={`${r.start}-${r.end}-${i}`}
              className="flex items-center gap-1.5 rounded-full border border-emerald-700 bg-emerald-500/10 px-2.5 py-1 tabular-nums text-emerald-300"
            >
              part {i + 1}: {fmtTime(r.start)}–{fmtTime(r.end)}
              <button
                onClick={() => setRanges(ranges.filter((_, j) => j !== i))}
                className="text-emerald-400 hover:text-white"
                title="Remove this part"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {duration != null && duration > 0 && (
        <RangeSlider
          duration={duration}
          start={start}
          end={end}
          playhead={showVideo ? playhead : null}
          onChange={handleRange}
          onSeek={(t) => {
            const v = videoRef.current;
            if (v && showVideo) {
              v.currentTime = t;
              setPlayhead(t);
            }
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {showVideo && (
          <button
            onClick={togglePlay}
            title="Space also toggles play/pause; click the timeline to seek"
            className="w-32 rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
          >
            {playing ? "⏸ Pause" : "▶ Play range"}
          </button>
        )}
        {showVideo && playhead != null && (
          <span className="tabular-nums text-xs text-slate-400">at {fmtTime(playhead)}</span>
        )}
        <label className="flex items-center gap-1.5 text-slate-300">
          from
          <input
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={(e) => commitText("start", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitText("start", startText)}
            className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums"
          />
        </label>
        <label className="flex items-center gap-1.5 text-slate-300">
          to
          <input
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            onBlur={(e) => commitText("end", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitText("end", endText)}
            className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-center tabular-nums"
          />
        </label>
        {file.audioTracks > 1 && (
          <label className="flex items-center gap-1.5 text-slate-300">
            source
            <select
              value={String(file.audioSource)}
              onChange={(e) => {
                const v = e.target.value;
                setAudioSource(
                  file.path,
                  v === "default" || v === "merge" ? v : Number(v),
                );
              }}
              title="This recording has multiple audio tracks (e.g. game + mic)"
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
            >
              <option value="default">track 1 (default)</option>
              {Array.from({ length: file.audioTracks - 1 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  track {i + 2}
                </option>
              ))}
              <option value="merge">merge all</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-slate-300">
          audio
          <select
            value={file.audio}
            onChange={(e) => setAudio(file.path, e.target.value as AudioOpt)}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
          >
            <option value="keep">keep</option>
            <option value="75">75%</option>
            <option value="50">50%</option>
            <option value="25">25%</option>
            <option value="mute">mute</option>
          </select>
        </label>
        <label
          className="flex items-center gap-1.5 text-slate-300"
          title="Balance loudness (one-pass loudnorm) — evens out quiet mics and loud game audio"
        >
          <input
            type="checkbox"
            checked={file.normalize}
            onChange={(e) => setNormalize(file.path, e.target.checked)}
            className="accent-emerald-500"
          />
          normalize
        </label>
        <span className="text-xs text-slate-500">
          {valid ? `${fmtTime(end - start)} selected` : "end must be after start"}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            disabled={!valid}
            onClick={addPart}
            title="Add the selected range as another exported part"
            className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
          >
            + Add part
          </button>
          {(ranges.length > 0 || file.trims.length > 0) && (
            <button
              onClick={() => {
                setTrims(file.path, []);
                onClose();
              }}
              className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            disabled={!valid && ranges.length === 0}
            onClick={apply}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {ranges.length > 0
              ? `Apply ${ranges.length} part${ranges.length > 1 ? "s" : ""}`
              : "Apply"}
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
  onChange,
  onSeek,
}: {
  duration: number;
  start: number;
  end: number;
  playhead?: number | null;
  onChange: (start: number, end: number, moved: "start" | "end") => void;
  onSeek?: (t: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<"start" | "end" | "seek" | null>(null);

  function timeAt(clientX: number): number {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  }

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  function nudge(which: "start" | "end", delta: number) {
    if (which === "start") {
      onChange(Math.min(Math.max(0, start + delta), end - MIN_GAP), end, "start");
    } else {
      onChange(start, Math.max(Math.min(duration, end + delta), start + MIN_GAP), "end");
    }
  }

  return (
    <div
      ref={trackRef}
      className="relative h-8 touch-none select-none"
      onPointerDown={(ev) => {
        // Thumbs stop propagation — a press here is a seek on the timeline.
        drag.current = "seek";
        (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
        onSeek?.(timeAt(ev.clientX));
      }}
      onPointerMove={(ev) => {
        if (!drag.current) return;
        const t = timeAt(ev.clientX);
        if (drag.current === "seek") onSeek?.(t);
        else if (drag.current === "start") onChange(Math.min(t, end - MIN_GAP), end, "start");
        else onChange(start, Math.max(t, start + MIN_GAP), "end");
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded bg-slate-700" />
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded bg-emerald-500/70"
        style={{ left: `${pct(start)}%`, width: `${Math.max(0, pct(end) - pct(start))}%` }}
      />
      {playhead != null && (
        <div
          className="pointer-events-none absolute top-0.5 bottom-0.5 w-0.5 rounded bg-white/80"
          style={{ left: `${pct(Math.min(duration, Math.max(0, playhead)))}%` }}
        />
      )}
      {(["start", "end"] as const).map((which) => (
        <div
          key={which}
          tabIndex={0}
          role="slider"
          aria-label={which === "start" ? "Trim start" : "Trim end"}
          aria-valuenow={which === "start" ? start : end}
          onPointerDown={(ev) => {
            ev.stopPropagation();
            drag.current = which;
            (ev.target as Element).setPointerCapture(ev.pointerId);
            ev.preventDefault();
          }}
          onKeyDown={(ev) => {
            // Arrow keys nudge the focused handle: 0.1 s, Shift = 1 s.
            const step = ev.shiftKey ? 1 : 0.1;
            if (ev.key === "ArrowLeft") nudge(which, -step);
            else if (ev.key === "ArrowRight") nudge(which, step);
            else return;
            ev.preventDefault();
          }}
          className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded bg-emerald-400 shadow focus:outline focus:outline-2 focus:outline-white/70"
          style={{ left: `${pct(which === "start" ? start : end)}%` }}
        />
      ))}
    </div>
  );
}
