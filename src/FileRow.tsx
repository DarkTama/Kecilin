import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { fmtSize, fmtTime, parseTime } from "./format";
import { useStore } from "./store";
import type { FileState, Trim } from "./store";

// Thumbnails are extracted one at a time — each is an ffmpeg spawn.
let thumbQueue: Promise<void> = Promise.resolve();

export function FileRow({ file, converting }: { file: FileState; converting: boolean }) {
  const [editing, setEditing] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    thumbQueue = thumbQueue.then(async () => {
      if (!live) return;
      try {
        const p = await invoke<string>("prepare_thumbnail", {
          path: file.path,
          duration: file.duration,
        });
        if (live) setThumb(convertFileSrc(p));
      } catch {
        // no thumbnail — the placeholder stays
      }
    });
    return () => {
      live = false;
    };
  }, [file.path, file.duration]);

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

  const trimBadge =
    file.trims.length === 1 ? (
      <span className="text-emerald-400">
        {" "}
        · ✂ {fmtTime(file.trims[0].start)}–{fmtTime(file.trims[0].end)}
      </span>
    ) : file.trims.length > 1 ? (
      <span className="text-emerald-400"> · ✂ {file.trims.length} parts</span>
    ) : null;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setEditing(!editing)}
          disabled={converting}
          title="Preview / trim"
          className="h-10 w-[71px] shrink-0 overflow-hidden rounded-md bg-slate-950 disabled:opacity-60"
        >
          {thumb ? (
            <img src={thumb} alt="" className="h-full w-full object-cover" />
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
          </div>
        </div>
        {badge}
        <button
          disabled={converting}
          onClick={() => setEditing(!editing)}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40"
        >
          {file.trims.length > 0 ? "Edit trim" : "Trim"}
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Native playback first; when the webview can't decode the file (HEVC
  // without the Windows codec, .mkv/.avi, …) fall back to a small H.264 proxy
  // re-encoded by the bundled ffmpeg. "none" only if even that fails.
  const [src, setSrc] = useState(() => convertFileSrc(file.path));
  const [preview, setPreview] = useState<"native" | "preparing" | "proxy" | "none">("native");
  const triedProxy = useRef(false);
  const [duration, setDuration] = useState<number | null>(file.duration);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [ranges, setRanges] = useState<Trim[]>(file.trims);
  const last = file.trims[file.trims.length - 1];
  const initStart = last?.start ?? 0;
  const initEnd = last?.end ?? file.duration ?? 0;
  const [start, setStart] = useState(initStart);
  const [end, setEnd] = useState(initEnd);
  const [startText, setStartText] = useState(fmtTime(initStart));
  const [endText, setEndText] = useState(fmtTime(initEnd));

  const showVideo = preview === "native" || preview === "proxy";

  async function fallbackToProxy() {
    if (triedProxy.current) {
      setPreview("none");
      return;
    }
    triedProxy.current = true;
    setPreview("preparing");
    try {
      const p = await invoke<string>("prepare_preview", { path: file.path });
      setSrc(convertFileSrc(p));
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

  function commitText(which: "start" | "end", text: string) {
    const t = parseTime(text);
    if (t == null) {
      setStartText(fmtTime(start));
      setEndText(fmtTime(end));
      return;
    }
    const max = duration ?? Number.POSITIVE_INFINITY;
    if (which === "start") update(Math.min(Math.max(0, t), end - 0.1), end, t);
    else update(start, Math.min(Math.max(t, start + 0.1), max), t);
  }

  const valid = end > start + 0.05;

  function addPart() {
    if (!valid) return;
    setRanges([...ranges, { start, end }]);
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
            if (!v.paused && v.currentTime >= end) v.pause();
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
          onChange={(ns, ne, moved) => update(ns, ne, moved === "start" ? ns : ne)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {showVideo && (
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
            {ranges.length > 0 ? `Apply ${ranges.length} part${ranges.length > 1 ? "s" : ""}` : "Apply"}
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
