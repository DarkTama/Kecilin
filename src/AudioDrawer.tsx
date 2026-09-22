import { useState, useEffect, memo } from "react";
import { useT } from "./i18n";
import { FileState, TrackInfo } from "./store";
import { generateWaveformData } from "./audio/waveform";
import { engine } from "./engine";

const WaveformLaneView = memo(function WaveformLaneView({
  peaks,
  enabled,
}: {
  peaks?: Float32Array;
  enabled: boolean;
}) {
  if (!peaks) return null;
  return (
    <svg
      className={`w-full h-6 ${
        enabled ? "text-emerald-500/75" : "text-slate-600"
      }`}
      viewBox={`0 0 ${peaks.length} 30`}
      preserveAspectRatio="none"
    >
      {Array.from(peaks).map((val, idx) => {
        if (val < 0.02) {
          return (
            <line
              key={idx}
              x1={idx}
              y1={15}
              x2={idx + 1}
              y2={15}
              stroke="currentColor"
              strokeWidth="1"
              opacity="0.3"
            />
          );
        }
        const h = Math.max(2, val * 26);
        return (
          <rect
            key={idx}
            x={idx}
            y={15 - h / 2}
            width="0.8"
            height={h}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
});

export function useAudioWaveforms(
  filePath: string,
  trackIndices: number[]
): { waveforms: Map<number, Float32Array>; loading: boolean } {
  const [waveforms, setWaveforms] = useState<Map<number, Float32Array>>(new Map());
  const [loading, setLoading] = useState(() => trackIndices.length > 0);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      const newWaves = new Map<number, Float32Array>();
      for (const index of trackIndices) {
        if (!active) return;
        try {
          const url = await engine.extractTrackAudio(filePath, index);
          if (!active) return;
          const peaks = await generateWaveformData(url, 300);
          if (!active) return;
          newWaves.set(index, peaks);
        } catch {
          // fallback to empty
        }
      }
      if (active) {
        setWaveforms(newWaves);
        setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, trackIndices.join(",")]);

  return { waveforms, loading };
}

export function AudioRack({
  file,
  onTrackChange,
  className,
}: {
  file: FileState;
  onTrackChange: (index: number, patch: Partial<TrackInfo>) => void;
  className?: string;
}) {
  const t = useT();
  const tracks = file.audioTracksInfo ?? [];

  return (
    <div className={`rounded-lg border border-slate-800 bg-slate-950/90 p-3 space-y-3 ${className ?? ""}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold uppercase tracking-wider text-slate-300">
          {t("audioTracks")} ({tracks.length})
        </span>
      </div>

      <div className="space-y-2.5">
        {tracks.map((track) => {
          const volPct = Math.round(track.volume * 100);
          const isBoosted = volPct > 100;

          return (
            <div
              key={track.index}
              className={`rounded-lg border p-2.5 space-y-1.5 transition-opacity ${
                track.enabled
                  ? "border-slate-800 bg-slate-900/60"
                  : "border-slate-900 bg-slate-950/40 opacity-40 hover:opacity-80"
              }`}
            >
              <div className="flex items-center justify-between text-xs">
                <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-200">
                  <input
                    type="checkbox"
                    checked={track.enabled}
                    onChange={(e) => onTrackChange(track.index, { enabled: e.target.checked })}
                    className="accent-emerald-500 h-3.5 w-3.5 rounded"
                  />
                  <span className="font-semibold text-emerald-400">{track.name}</span>
                </label>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    <span className={isBoosted ? "text-amber-400 font-bold" : "text-slate-400"}>
                      {isBoosted ? t("boost") : "Vol"}:
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="200"
                      value={volPct}
                      disabled={!track.enabled}
                      onChange={(e) =>
                        onTrackChange(track.index, { volume: Number(e.target.value) / 100 })
                      }
                      className="w-20 h-1 bg-slate-800 rounded cursor-pointer accent-emerald-500"
                    />
                    <span
                      className={`w-10 text-right ${
                        isBoosted ? "text-amber-400 font-bold" : "text-emerald-400"
                      }`}
                    >
                      {volPct}%
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onTrackChange(track.index, { muted: !track.muted })}
                    className={`px-2 py-0.5 rounded text-[10px] border ${
                      track.muted
                        ? "border-amber-600/60 bg-amber-950/40 text-amber-300 font-semibold"
                        : "border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
                    }`}
                  >
                    {track.muted ? t("muted") : t("mute")}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function WaveformLanes({
  file,
  playhead,
  waveforms,
  className,
}: {
  file: FileState;
  playhead: number | null;
  waveforms?: Map<number, Float32Array>;
  className?: string;
}) {
  const tracks = file.audioTracksInfo ?? [];

  const playheadPct =
    file.duration && playhead != null
      ? Math.max(0, Math.min(100, (playhead / file.duration) * 100))
      : null;

  return (
    <div className={`space-y-2.5 ${className ?? ""}`}>
      {tracks.map((track) => {
        const peaks = waveforms?.get(track.index);
        return (
          <div
            key={track.index}
            className="relative h-8 w-full bg-slate-950 rounded border border-slate-800/80 overflow-hidden flex items-center"
          >
            <span className="absolute left-1 top-0.5 z-10 px-1 rounded bg-slate-900/80 text-[10px] font-semibold text-emerald-400">
              {track.name}
            </span>
            <WaveformLaneView peaks={peaks} enabled={track.enabled} />
            {playheadPct != null && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 shadow-[0_0_4px_#22d3ee]"
                style={{ left: `${playheadPct}%` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AudioDrawer({
  file,
  playhead,
  onTrackChange,
}: {
  file: FileState;
  playhead: number | null;
  onTrackChange: (index: number, patch: Partial<TrackInfo>) => void;
}) {
  const t = useT();
  const tracks = file.audioTracksInfo ?? [];
  const trackIndices = tracks.map((track) => track.index);
  const { waveforms, loading } = useAudioWaveforms(file.path, trackIndices);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/90 p-3 space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold uppercase tracking-wider text-slate-300">
          {t("audioTracks")} ({tracks.length})
        </span>
        {loading && (
          <span className="text-emerald-400 animate-pulse text-[11px]">
            {t("extractingAudio")}
          </span>
        )}
      </div>

      <div className="space-y-2.5">
        {tracks.map((track) => {
          const peaks = waveforms.get(track.index);
          const volPct = Math.round(track.volume * 100);
          const isBoosted = volPct > 100;
          const playheadPct =
            file.duration && playhead != null
              ? Math.max(0, Math.min(100, (playhead / file.duration) * 100))
              : null;

          return (
            <div
              key={track.index}
              className={`rounded-lg border p-2.5 space-y-1.5 transition-opacity ${
                track.enabled
                  ? "border-slate-800 bg-slate-900/60"
                  : "border-slate-900 bg-slate-950/40 opacity-40 hover:opacity-80"
              }`}
            >
              <div className="flex items-center justify-between text-xs">
                <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-200">
                  <input
                    type="checkbox"
                    checked={track.enabled}
                    onChange={(e) => onTrackChange(track.index, { enabled: e.target.checked })}
                    className="accent-emerald-500 h-3.5 w-3.5 rounded"
                  />
                  <span className="font-semibold text-emerald-400">{track.name}</span>
                </label>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    <span className={isBoosted ? "text-amber-400 font-bold" : "text-slate-400"}>
                      {isBoosted ? t("boost") : "Vol"}:
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="200"
                      value={volPct}
                      disabled={!track.enabled}
                      onChange={(e) =>
                        onTrackChange(track.index, { volume: Number(e.target.value) / 100 })
                      }
                      className="w-20 h-1 bg-slate-800 rounded cursor-pointer accent-emerald-500"
                    />
                    <span
                      className={`w-10 text-right ${
                        isBoosted ? "text-amber-400 font-bold" : "text-emerald-400"
                      }`}
                    >
                      {volPct}%
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onTrackChange(track.index, { muted: !track.muted })}
                    className={`px-2 py-0.5 rounded text-[10px] border ${
                      track.muted
                        ? "border-amber-600/60 bg-amber-950/40 text-amber-300 font-semibold"
                        : "border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
                    }`}
                  >
                    {track.muted ? t("muted") : t("mute")}
                  </button>
                </div>
              </div>

              {/* Waveform Lane */}
              <div className="relative h-8 w-full bg-slate-950 rounded border border-slate-800/80 overflow-hidden flex items-center">
                <WaveformLaneView peaks={peaks} enabled={track.enabled} />
                {playheadPct != null && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 shadow-[0_0_4px_#22d3ee]"
                    style={{ left: `${playheadPct}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
