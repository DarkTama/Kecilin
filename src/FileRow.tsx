import { useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fmtSize, fmtTime, parseTime } from "./format";
import { useStore } from "./store";
import type { FileState } from "./store";

export function FileRow({ file, converting }: { file: FileState; converting: boolean }) {
  const [editing, setEditing] = useState(false);

  const badge = {
    queued: converting ? <span className="text-xs text-slate-500">queued</span> : null,
    running: (
      <span className="text-xs tabular-nums text-emerald-400">{Math.round(file.percent)}%</span>
    ),
    done: <span className="text-xs text-emerald-400">✓ done</span>,
    failed: (
      <span className="text-xs text-red-400" title={file.error ?? undefined}>
        ✗ failed
      </span>
    ),
    canceled: <span className="text-xs text-amber-400">canceled</span>,
  }[file.status];

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={file.path}>
            {file.name}
          </div>
          <div className="text-xs text-slate-400">
            {fmtSize(file.size)}
            {file.duration != null && <> · {fmtTime(file.duration)}</>}
            {file.trim && (
              <span className="text-emerald-400">
                {" "}
                · ✂ {fmtTime(file.trim.start)}–{fmtTime(file.trim.end)}
              </span>
            )}
          </div>
        </div>
        {badge}
        <button
          disabled={converting}
          onClick={() => setEditing(!editing)}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40"
        >
          {file.trim ? "Edit trim" : "Trim"}
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
  const setTrim = useStore((st) => st.setTrim);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // WebView2 plays .mp4/.webm natively but usually not .mkv/.avi/.mov; when the
  // preview can't load we fall back to the slider + typed times alone.
  const [canPreview, setCanPreview] = useState(true);
  const [duration, setDuration] = useState<number | null>(file.duration);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const initStart = file.trim?.start ?? 0;
  const initEnd = file.trim?.end ?? file.duration ?? 0;
  const [start, setStart] = useState(initStart);
  const [end, setEnd] = useState(initEnd);
  const [startText, setStartText] = useState(fmtTime(initStart));
  const [endText, setEndText] = useState(fmtTime(initEnd));

  function update(ns: number, ne: number, scrubTo?: number) {
    setStart(ns);
    setEnd(ne);
    setStartText(fmtTime(ns));
    setEndText(fmtTime(ne));
    const v = videoRef.current;
    if (v && scrubTo != null && canPreview) v.currentTime = scrubTo;
  }

  function commitText(which: "start" | "end", text: string) {
    const t = parseTime(text);
    if (t == null) {
      // Unparseable — snap the field back to the current value.
      setStartText(fmtTime(start));
      setEndText(fmtTime(end));
      return;
    }
    const max = duration ?? Number.POSITIVE_INFINITY;
    if (which === "start") update(Math.min(Math.max(0, t), end - 0.1), end, t);
    else update(start, Math.min(Math.max(t, start + 0.1), max), t);
  }

  const valid = end > start + 0.05;

  function apply() {
    // Full range selected = no trim at all.
    const full = start <= 0.05 && duration != null && end >= duration - 0.05;
    setTrim(file.path, full ? null : { start, end });
    onClose();
  }

  return (
    <div className="flex flex-col gap-3 border-t border-slate-800 px-4 py-4">
      {canPreview ? (
        <video
          ref={videoRef}
          src={convertFileSrc(file.path)}
          className="max-h-64 w-full rounded-lg bg-black"
          onError={() => setCanPreview(false)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (Number.isFinite(v.duration)) {
              setDuration((d) => d ?? v.duration);
              if (end <= 0) update(start, v.duration);
            }
            // Audio decodes but the video track can't (e.g. HEVC without the
            // Windows codec extension): no error fires, frames stay black,
            // and videoWidth stays 0 — fall back instead of showing black.
            if (v.videoWidth === 0) setCanPreview(false);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setPlayhead(v.currentTime);
            if (!v.paused && v.currentTime >= end) v.pause();
          }}
        />
      ) : (
        <p className="text-xs text-slate-400">
          Preview isn't available — this file's video codec can't be decoded by the app's webview
          (common for HEVC/H.265 without Windows' HEVC extension). Trim with the slider or typed
          times below; <b>conversion is unaffected</b>.
        </p>
      )}

      {duration != null && duration > 0 && (
        <RangeSlider
          duration={duration}
          start={start}
          end={end}
          playhead={canPreview ? playhead : null}
          onChange={(ns, ne, moved) => update(ns, ne, moved === "start" ? ns : ne)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {canPreview && (
          <button
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              if (playing) {
                v.pause();
                return;
              }
              // Resume from where it paused; restart when outside the range.
              if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
              v.play();
            }}
            className="w-32 rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
          >
            {playing ? "⏸ Pause" : "▶ Play range"}
          </button>
        )}
        {canPreview && playhead != null && (
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
        <span className="text-xs text-slate-500">
          {valid ? `${fmtTime(end - start)} kept` : "end must be after start"}
        </span>
        <div className="ml-auto flex gap-2">
          {file.trim && (
            <button
              onClick={() => {
                setTrim(file.path, null);
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
            disabled={!valid}
            onClick={apply}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            Apply
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
}: {
  duration: number;
  start: number;
  end: number;
  playhead?: number | null;
  onChange: (start: number, end: number, moved: "start" | "end") => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<"start" | "end" | null>(null);

  function timeAt(clientX: number): number {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  }

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  return (
    <div
      ref={trackRef}
      className="relative h-8 touch-none select-none"
      onPointerMove={(ev) => {
        if (!drag.current) return;
        const t = timeAt(ev.clientX);
        if (drag.current === "start") onChange(Math.min(t, end - MIN_GAP), end, "start");
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
          onPointerDown={(ev) => {
            drag.current = which;
            (ev.target as Element).setPointerCapture(ev.pointerId);
            ev.preventDefault();
          }}
          className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded bg-emerald-400 shadow"
          style={{ left: `${pct(which === "start" ? start : end)}%` }}
        />
      ))}
    </div>
  );
}
