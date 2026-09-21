# Multi-Track Audio Selection, Waveform Activity, and Live Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide full multi-track audio management in Kecilin: detect OBS stream titles, allow arbitrary multi-track inclusion with volume sliders/boost (0%–200%), display timeline-aligned waveform lanes indicating audio activity/silence, and support real-time preview mixing via Web Audio API.

**Architecture:** Rust probes stream metadata titles from FFmpeg header output and exposes an on-demand audio demuxing command. Frontend decodes audio buffers with Web Audio API for fast RMS/peak downsampling to render timeline-aligned SVG waveforms and runs a synchronized multi-gain audio graph locked to `<video>`. FFmpeg export chains per-track volume filters into `amix` to produce a single stereo AAC stream for WhatsApp.

**Tech Stack:** Rust (Tauri 2, FFmpeg CLI), TypeScript, React 18, Zustand, Web Audio API, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-multi-track-audio-design.md`

## Global Constraints

- Preserve backward compatibility for single-track files: 1-track files show an inline slider on the bottom bar without requiring drawer expansion.
- WhatsApp output audio must always be a single stereo AAC stream (`-c:a aac -q:a 2 -ar 48000 -ac 2`).
- Waveform audio extraction must be lazy: runs only when the Audio Drawer is expanded by the user.
- Volume boost (>100% up to 200%) must be supported both in the live Web Audio preview and the final FFmpeg filtergraph (`volume=X`).
- All existing tests in `npm test` and `cargo test` must continue to pass.

---

### Task 1: Rust Audio Track Metadata Parser

**Files:**
- Modify: `src-tauri/src/commands.rs:160-330`
- Test: `src-tauri/src/commands.rs` (internal tests module)

**Interfaces:**
- Consumes: FFmpeg stderr header output from probe.
- Produces: `AudioTrackMeta { index: usize, name: String, enabled: bool, volume: f32 }`, function `parse_audio_tracks_info(stderr: &str) -> Vec<AudioTrackMeta>`.

- [ ] **Step 1: Write the failing unit test**

In `src-tauri/src/commands.rs` within `mod tests`:
```rust
    #[test]
    fn parses_audio_track_titles_from_ffmpeg_header() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'obs.mp4':
  Duration: 00:01:30.00, start: 0.000000, bitrate: 12000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High)
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 320 kb/s (default)
    Metadata:
      title           : Desktop Audio
  Stream #0:2[0x3](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 320 kb/s
    Metadata:
      title           : Mic / Auxiliary
  Stream #0:3[0x4](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 320 kb/s
    Metadata:
      title           : Discord
"#;
        let tracks = parse_audio_tracks_info(stderr);
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].index, 0);
        assert_eq!(tracks[0].name, "Desktop Audio");
        assert!(tracks[0].enabled);
        assert_eq!(tracks[1].index, 1);
        assert_eq!(tracks[1].name, "Mic / Auxiliary");
        assert!(tracks[1].enabled);
        assert_eq!(tracks[2].index, 2);
        assert_eq!(tracks[2].name, "Discord");
        assert!(!tracks[2].enabled);
    }

    #[test]
    fn parses_audio_tracks_fallback_without_metadata() {
        let stderr = r#"
  Stream #0:1: Audio: aac, 48000 Hz, stereo
  Stream #0:2: Audio: aac, 48000 Hz, stereo
"#;
        let tracks = parse_audio_tracks_info(stderr);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].name, "Track 1");
        assert!(tracks[0].enabled);
        assert_eq!(tracks[1].name, "Track 2");
        assert!(!tracks[1].enabled);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib parses_audio_track_titles`
Expected: FAIL with `cannot find function 'parse_audio_tracks_info' in this scope`

- [ ] **Step 3: Implement `AudioTrackMeta` and `parse_audio_tracks_info`**

In `src-tauri/src/commands.rs`:
```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioTrackMeta {
    pub index: usize,
    pub name: String,
    pub enabled: bool,
    pub volume: f32,
}

pub(crate) fn parse_audio_tracks_info(stderr: &str) -> Vec<AudioTrackMeta> {
    let mut tracks = Vec::new();
    let mut current_idx = None;
    let mut current_title: Option<String> = None;

    let flush_track = |tracks: &mut Vec<AudioTrackMeta>, idx: Option<usize>, title: Option<String>| {
        if let Some(i) = idx {
            let name = title.unwrap_or_else(|| format!("Track {}", i + 1));
            tracks.push(AudioTrackMeta {
                index: i,
                name,
                enabled: false,
                volume: 1.0,
            });
        }
    };

    let lines: Vec<&str> = stderr.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.contains("Stream #") && line.contains("Audio:") {
            flush_track(&mut tracks, current_idx, current_title);
            current_idx = Some(tracks.len());
            current_title = None;
        } else if current_idx.is_some() && line.trim().starts_with("title") && line.contains(':') {
            if let Some(pos) = line.find(':') {
                let t = line[pos + 1..].trim().to_string();
                if !t.is_empty() {
                    current_title = Some(t);
                }
            }
        }
        i += 1;
    }
    flush_track(&mut tracks, current_idx, current_title);

    if tracks.len() == 1 {
        tracks[0].enabled = true;
    } else if tracks.len() > 1 {
        let has_master = tracks.iter().any(|t| {
            let l = t.name.to_lowercase();
            l.contains("master") || l.contains("all audio")
        });
        if has_master {
            for t in tracks.iter_mut() {
                let l = t.name.to_lowercase();
                if l.contains("master") || l.contains("all audio") {
                    t.enabled = true;
                    break;
                }
            }
        } else {
            // Enable recognized primary sources (Desktop/Game and Mic/Aux) or Track 0 & 1
            for t in tracks.iter_mut() {
                let l = t.name.to_lowercase();
                if l.contains("desktop") || l.contains("game") || l.contains("mic") || l.contains("aux") {
                    t.enabled = true;
                }
            }
            if !tracks.iter().any(|t| t.enabled) {
                tracks[0].enabled = true;
            }
        }
    }

    tracks
}
```

Update `VideoFile` struct:
```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub duration: Option<f64>,
    pub audio_tracks: usize,
    pub audio_tracks_info: Vec<AudioTrackMeta>,
}
```
Update `probe_files` in `commands.rs` to populate `audio_tracks_info: parse_audio_tracks_info(&stderr)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib parses_audio_track`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(tauri): parse stream titles and audio track metadata in probe"
```

---

### Task 2: Multi-Track FFmpeg Filtergraph & On-Demand Demux Command

**Files:**
- Modify: `src-tauri/src/commands.rs:430-530`, `src-tauri/src/lib.rs:25-45`
- Test: `src-tauri/src/commands.rs` (internal tests module)

**Interfaces:**
- Consumes: `AudioTrackMeta` list from queue item.
- Produces: Tauri command `extract_track_audio(app: AppHandle, path: String, index: usize) -> Result<String, String>`, updated `build_args` and `build_speed_filtergraph` handling `Vec<AudioTrackMeta>`.

- [ ] **Step 1: Write the failing unit test for multi-track filtergraph**

In `src-tauri/src/commands.rs` within `mod tests`:
```rust
    #[test]
    fn multi_track_filtergraph_mixes_enabled_tracks_with_volume() {
        let tracks = vec![
            AudioTrackMeta { index: 0, name: "Desktop".into(), enabled: true, volume: 1.0 },
            AudioTrackMeta { index: 1, name: "Mic".into(), enabled: true, volume: 1.4 },
            AudioTrackMeta { index: 2, name: "Music".into(), enabled: false, volume: 0.8 },
        ];
        let graph = build_audio_filtergraph(&tracks, false);
        assert_eq!(
            graph,
            Some("[0:a:0]volume=1.000[a0];[0:a:1]volume=1.400[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0[aout]".to_string())
        );
    }

    #[test]
    fn multi_track_filtergraph_with_loudnorm() {
        let tracks = vec![
            AudioTrackMeta { index: 0, name: "Desktop".into(), enabled: true, volume: 1.0 },
        ];
        let graph = build_audio_filtergraph(&tracks, true);
        assert_eq!(
            graph,
            Some(format!("[0:a:0]volume=1.000,{}[aout]", LOUDNORM))
        );
    }

    #[test]
    fn multi_track_filtergraph_all_disabled_returns_none() {
        let tracks = vec![
            AudioTrackMeta { index: 0, name: "Desktop".into(), enabled: false, volume: 1.0 },
        ];
        assert_eq!(build_audio_filtergraph(&tracks, false), None);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib multi_track_filtergraph`
Expected: FAIL with `cannot find function 'build_audio_filtergraph'`

- [ ] **Step 3: Implement `build_audio_filtergraph` and `extract_track_audio`**

In `src-tauri/src/commands.rs`:
```rust
pub(crate) fn build_audio_filtergraph(tracks: &[AudioTrackMeta], normalize: bool) -> Option<String> {
    let enabled: Vec<&AudioTrackMeta> = tracks.iter().filter(|t| t.enabled && t.volume > 0.001).collect();
    if enabled.is_empty() {
        return None;
    }

    let norm_chain = if normalize { format!(",{}", LOUDNORM) } else { String::new() };

    if enabled.len() == 1 {
        let t = enabled[0];
        return Some(format!("[0:a:{}]volume={:.3}{norm_chain}[aout]", t.index, t.volume));
    }

    let mut parts = Vec::new();
    let mut inputs = String::new();
    for (i, t) in enabled.iter().enumerate() {
        let label = format!("a{i}");
        parts.push(format!("[0:a:{}]volume={:.3}[{label}]", t.index, t.volume));
        inputs.push_str(&format!("[{label}]"));
    }
    parts.push(format!("{inputs}amix=inputs={}:duration=longest:normalize=0{norm_chain}[aout]", enabled.len()));
    Some(parts.join(";"))
}
```

Add `extract_track_audio` command:
```rust
#[tauri::command]
pub async fn extract_track_audio(
    app: AppHandle,
    path: String,
    index: usize,
) -> Result<String, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("audio_tracks");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let hash = format!("{:x}", md5::compute(format!("{}:{}", path, index)));
    let out_path = cache_dir.join(format!("{hash}.m4a"));
    let out_str = out_path.to_str().ok_or("invalid utf-8 path")?.to_string();

    if out_path.exists() {
        return Ok(out_str);
    }

    let status = ffmpeg(&app)?
        .args([
            "-y", "-hide_banner", "-i", &path,
            "-map", &format!("0:a:{index}"),
            "-vn", "-c:a", "aac", "-b:a", "96k",
            &out_str,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !status.status.success() {
        let _ = fs::remove_file(&out_path);
        return Err("failed to demux audio track".into());
    }

    Ok(out_str)
}
```
Register `commands::extract_track_audio` in `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib multi_track_filtergraph`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): add multi-track audio filtergraph and extract_track_audio command"
```

---

### Task 3: TypeScript Store State & Engine Types

**Files:**
- Modify: `src/store.ts:75-120`, `src/engine/types.ts:110-150`, `src/engine/tauri.ts:125-155`
- Test: `src/store.test.ts` (or `src/preview.test.ts`)

**Interfaces:**
- Consumes: `AudioTrackMeta` from Rust backend.
- Produces: `TrackInfo` type, store actions `setTrackEnabled`, `setTrackVolume`, `setTrackMuted`, engine method `extractTrackAudio(path: string, index: number): Promise<string>`.

- [ ] **Step 1: Write the failing unit test for store actions**

In `src/store.test.ts` (create or add to existing test file):
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store";

describe("store multi-track audio actions", () => {
  beforeEach(() => {
    useStore.setState({
      files: [
        {
          path: "/test/video.mp4",
          name: "video.mp4",
          size: 1000,
          duration: 60,
          audioTracks: 2,
          audioTracksInfo: [
            { index: 0, name: "Desktop", enabled: true, volume: 1.0, muted: false },
            { index: 1, name: "Mic", enabled: true, volume: 1.0, muted: false },
          ],
          trims: [],
          speedRanges: [],
          audio: "keep",
          audioSource: "default",
          normalize: false,
          outputs: [],
          status: "queued",
          percent: 0,
          error: null,
        },
      ],
    });
  });

  it("updates track enabled and volume state", () => {
    const { setTrackEnabled, setTrackVolume } = useStore.getState();
    setTrackEnabled("/test/video.mp4", 1, false);
    setTrackVolume("/test/video.mp4", 0, 1.4);

    const f = useStore.getState().files[0];
    expect(f.audioTracksInfo[1].enabled).toBe(false);
    expect(f.audioTracksInfo[0].volume).toBe(1.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/store.test.ts`
Expected: FAIL with `setTrackEnabled is not a function`

- [ ] **Step 3: Implement store types & actions**

In `src/store.ts`:
```typescript
export type TrackInfo = {
  index: number;
  name: string;
  enabled: boolean;
  volume: number; // 0.0 to 2.0
  muted: boolean;
};

export type VideoFile = {
  path: string;
  name: string;
  size: number;
  duration: number | null;
  audioTracks: number;
  audioTracksInfo?: TrackInfo[];
};

// In StoreActions:
setTrackEnabled: (path: string, index: number, enabled: boolean) => void;
setTrackVolume: (path: string, index: number, volume: number) => void;
setTrackMuted: (path: string, index: number, muted: boolean) => void;
```

Implement in `create<StoreState>()`:
```typescript
  setTrackEnabled: (path, index, enabled) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.path === path
          ? {
              ...f,
              audioTracksInfo: (f.audioTracksInfo ?? []).map((t) =>
                t.index === index ? { ...t, enabled } : t
              ),
            }
          : f
      ),
    })),
  setTrackVolume: (path, index, volume) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.path === path
          ? {
              ...f,
              audioTracksInfo: (f.audioTracksInfo ?? []).map((t) =>
                t.index === index ? { ...t, volume } : t
              ),
            }
          : f
      ),
    })),
  setTrackMuted: (path, index, muted) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.path === path
          ? {
              ...f,
              audioTracksInfo: (f.audioTracksInfo ?? []).map((t) =>
                t.index === index ? { ...t, muted } : t
              ),
            }
          : f
      ),
    })),
```

In `src/engine/types.ts` & `src/engine/tauri.ts`:
```typescript
extractTrackAudio: (path: string, index: number) => Promise<string>;
// In tauri.ts:
extractTrackAudio: async (path, index) => {
  const p = await invoke<string>("extract_track_audio", { path, index });
  return convertFileSrc(p);
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/engine/types.ts src/engine/tauri.ts src/store.test.ts
git commit -m "feat: add multi-track audio store actions and engine bindings"
```

---

### Task 4: Waveform Peak Extraction Module

**Files:**
- Create: `src/audio/waveform.ts`
- Test: `src/audio/waveform.test.ts`

**Interfaces:**
- Consumes: Audio file array buffer / Web Audio PCM buffer.
- Produces: `computePeaks(pcmData: Float32Array, numBuckets: number): Float32Array`, `generateWaveformData(audioUrl: string, buckets?: number): Promise<Float32Array>`.

- [ ] **Step 1: Write the failing unit test**

Create `src/audio/waveform.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { computePeaks } from "./waveform";

describe("computePeaks", () => {
  it("returns zero peaks for silent PCM data", () => {
    const silent = new Float32Array(1000).fill(0);
    const peaks = computePeaks(silent, 10);
    expect(peaks.length).toBe(10);
    peaks.forEach((p) => expect(p).toBe(0));
  });

  it("detects peak amplitudes correctly across buckets", () => {
    const data = new Float32Array(100);
    // Put a spike in the first half
    data[10] = 0.8;
    data[11] = -0.9;
    const peaks = computePeaks(data, 2);
    expect(peaks[0]).toBeCloseTo(0.9, 2);
    expect(peaks[1]).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/audio/waveform.test.ts`
Expected: FAIL with `Cannot find module './waveform'`

- [ ] **Step 3: Implement `src/audio/waveform.ts`**

```typescript
export function computePeaks(pcmData: Float32Array, numBuckets: number): Float32Array {
  const peaks = new Float32Array(numBuckets);
  if (pcmData.length === 0 || numBuckets === 0) return peaks;

  const bucketSize = pcmData.length / numBuckets;
  for (let i = 0; i < numBuckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(pcmData.length, Math.floor((i + 1) * bucketSize));
    let max = 0;
    for (let j = start; j < end; j++) {
      const val = Math.abs(pcmData[j]);
      if (val > max) max = val;
    }
    peaks[i] = max;
  }
  return peaks;
}

export async function generateWaveformData(
  audioUrl: string,
  numBuckets = 300
): Promise<Float32Array> {
  const resp = await fetch(audioUrl);
  const buffer = await resp.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(buffer);
    const channelData = audioBuffer.getChannelData(0);
    return computePeaks(channelData, numBuckets);
  } finally {
    void ctx.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/audio/waveform.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audio/waveform.ts src/audio/waveform.test.ts
git commit -m "feat(audio): add waveform peak extraction and bucket downsampler"
```

---

### Task 5: Web Audio Preview Mixer

**Files:**
- Create: `src/audio/mixer.ts`
- Test: `src/audio/mixer.test.ts`

**Interfaces:**
- Consumes: Array of `{ index: number, url: string, volume: number, muted: boolean }`, HTMLVideoElement reference.
- Produces: `AudioTrackMixer` class with `sync(currentTime, isPlaying)`, `setVolume(index, volume)`, `setMuted(index, muted)`, `dispose()`.

- [ ] **Step 1: Write the failing unit test**

Create `src/audio/mixer.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { AudioTrackMixer } from "./mixer";

describe("AudioTrackMixer", () => {
  it("initializes without crashing in environment", () => {
    const mixer = new AudioTrackMixer();
    expect(mixer).toBeDefined();
    mixer.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/audio/mixer.test.ts`
Expected: FAIL with `Cannot find module './mixer'`

- [ ] **Step 3: Implement `src/audio/mixer.ts`**

```typescript
export type TrackSourceConfig = {
  index: number;
  url: string;
  volume: number;
  muted: boolean;
};

export class AudioTrackMixer {
  private ctx: AudioContext | null = null;
  private gainNodes = new Map<number, GainNode>();
  private buffers = new Map<number, AudioBuffer>();
  private sources = new Map<number, AudioBufferSourceNode>();
  private isPlaying = false;
  private currentPlayhead = 0;

  constructor() {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      this.ctx = new AudioCtx();
    }
  }

  async loadTrack(index: number, url: string): Promise<void> {
    if (!this.ctx) return;
    const resp = await fetch(url);
    const ab = await resp.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(ab);
    this.buffers.set(index, audioBuffer);

    if (!this.gainNodes.has(index)) {
      const g = this.ctx.createGain();
      g.connect(this.ctx.destination);
      this.gainNodes.set(index, g);
    }
  }

  setTrackVolume(index: number, volume: number, muted = false): void {
    const g = this.gainNodes.get(index);
    if (!g || !this.ctx) return;
    const target = muted ? 0 : volume;
    g.gain.setValueAtTime(target, this.ctx.currentTime);
  }

  play(fromTime: number): void {
    if (!this.ctx) return;
    this.stop();
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.isPlaying = true;
    this.currentPlayhead = fromTime;

    for (const [index, buffer] of this.buffers.entries()) {
      if (fromTime >= buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const g = this.gainNodes.get(index);
      if (g) src.connect(g);
      src.start(0, Math.max(0, fromTime));
      this.sources.set(index, src);
    }
  }

  pause(): void {
    this.stop();
    this.isPlaying = false;
  }

  seek(toTime: number): void {
    if (this.isPlaying) {
      this.play(toTime);
    } else {
      this.currentPlayhead = toTime;
    }
  }

  private stop(): void {
    for (const src of this.sources.values()) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore if already stopped
      }
    }
    this.sources.clear();
  }

  dispose(): void {
    this.stop();
    this.gainNodes.clear();
    this.buffers.clear();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/audio/mixer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audio/mixer.ts src/audio/mixer.test.ts
git commit -m "feat(audio): implement Web Audio live track preview mixer"
```

---

### Task 6: Audio Drawer Component

**Files:**
- Create: `src/AudioDrawer.tsx`
- Modify: `src/i18n.ts:110-130`, `src/i18n.ts:310-330`

**Interfaces:**
- Consumes: `file: FileState`, `playhead: number | null`, `duration: number | null`, `onVolumeChange`, `onToggleTrack`.
- Produces: `AudioDrawer` component with waveform SVG lanes, checkboxes, volume sliders, and mute buttons aligned with master timeline.

- [ ] **Step 1: Add localization strings**

In `src/i18n.ts`:
Add EN:
```typescript
audioTracks: "Audio Tracks",
tracksSelected: "{n} selected",
boost: "Boost",
desktopAudio: "Desktop Audio",
micAux: "Mic / Aux",
extractingAudio: "Analyzing audio waveforms...",
```
Add ID:
```typescript
audioTracks: "Trek Audio",
tracksSelected: "{n} dipilih",
boost: "Tingkatkan",
desktopAudio: "Audio Desktop",
micAux: "Mikrofon / Aux",
extractingAudio: "Menganalisis gelombang audio...",
```

- [ ] **Step 2: Implement `src/AudioDrawer.tsx`**

```tsx
import { useState, useEffect, useRef } from "react";
import { useT } from "./i18n";
import { FileState, TrackInfo } from "./store";
import { generateWaveformData } from "./audio/waveform";
import { engine } from "./engine";

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
  const [waveforms, setWaveforms] = useState<Map<number, Float32Array>>(new Map());
  const [loading, setLoading] = useState(true);

  const tracks = file.audioTracksInfo ?? [];

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      const newWaves = new Map<number, Float32Array>();
      for (const track of tracks) {
        try {
          const url = await engine.extractTrackAudio(file.path, track.index);
          if (!active) return;
          const peaks = await generateWaveformData(url, 300);
          newWaves.set(track.index, peaks);
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
  }, [file.path, tracks.length]);

  const playheadPct =
    file.duration && playhead != null
      ? Math.max(0, Math.min(100, (playhead / file.duration) * 100))
      : null;

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
                    {track.muted ? "Muted" : "Mute"}
                  </button>
                </div>
              </div>

              {/* Waveform Lane */}
              <div className="relative h-8 w-full bg-slate-950 rounded border border-slate-800/80 overflow-hidden flex items-center px-1">
                {peaks && (
                  <svg
                    className={`w-full h-6 ${
                      track.enabled ? "text-emerald-500/75" : "text-slate-600"
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
                )}
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
```

- [ ] **Step 3: Run Vitest to ensure no compilation errors**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/AudioDrawer.tsx src/i18n.ts
git commit -m "feat(ui): create timeline-aligned AudioDrawer with waveforms and boost controls"
```

---

### Task 7: TrimEditor Integration & Single-Track Slider

**Files:**
- Modify: `src/FileRow.tsx:1230-1280`
- Test: Manual browser preview & full Vitest test suite

**Interfaces:**
- Consumes: `AudioDrawer` component, `AudioTrackMixer`.
- Produces: Integrated TrimEditor supporting both single-track volume slider on bottom bar and expandable AudioDrawer for multi-track files.

- [ ] **Step 1: Connect AudioMixer inside TrimEditor**

In `src/FileRow.tsx`:
- Instantiate `AudioTrackMixer` ref inside `TrimEditor`.
- For multi-track files: mute `<video>` tag (`videoRef.current.muted = true`) and hook playback events:
  - `onPlay`: `mixer.play(v.currentTime)`
  - `onPause`: `mixer.pause()`
  - `onTimeUpdate` / seeking: `mixer.seek(v.currentTime)`
- Clean up mixer on component unmount (`mixer.dispose()`).

- [ ] **Step 2: Add Audio Drawer toggle and Single-Track Slider to Bottom Bar**

In `src/FileRow.tsx` around line 1240:
- If `file.audioTracks > 1`:
  - Render toggle button:
    ```tsx
    <button
      type="button"
      onClick={() => setAudioDrawerOpen((o) => !o)}
      className="px-2.5 py-1 rounded-md border border-emerald-700/60 bg-emerald-950/40 text-emerald-300 text-xs font-medium hover:bg-emerald-900/50 flex items-center gap-1"
    >
      🎚️ {t("audioTracks")} ({enabledTrackCount} {t("tracksSelected")})
      <span className="text-[10px] font-mono">{audioDrawerOpen ? "▲" : "▼"}</span>
    </button>
    ```
  - When `audioDrawerOpen` is true, render `<AudioDrawer />` directly under the master range scrubber bar.
- If `file.audioTracks <= 1`:
  - Replace dropdown with continuous slider:
    ```tsx
    <label className="flex items-center gap-1.5 text-xs text-slate-300">
      <span>Vol:</span>
      <input
        type="range"
        min="0"
        max="200"
        value={singleTrackVol}
        onChange={(e) => setSingleTrackVol(Number(e.target.value))}
        className="w-20 h-1 bg-slate-800 rounded accent-emerald-500"
      />
      <span className="font-mono text-emerald-400 w-9">{singleTrackVol}%</span>
    </label>
    ```

- [ ] **Step 3: Run Vitest and Cargo test suites**

Run: `npm test && cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/FileRow.tsx
git commit -m "feat(ui): integrate AudioDrawer and dynamic volume slider in TrimEditor"
```
