# Design Spec: Multi-Track Audio Selection, Waveform Activity, and Live Preview

- **Date:** 2026-09-21
- **Status:** Approved Draft
- **Target:** Kecilin v0.11.0

---

## 1. Overview & Goals

Kecilin v0.10.0 allows selecting either a single audio track or merging all tracks indiscriminately, labeled generically as "track 1", "track 2". This design adds comprehensive multi-track audio management:
1. **Track Names:** Read stream metadata titles from OBS/recording software (e.g. "Desktop Audio", "Mic / Auxiliary") rather than generic numeric labels.
2. **Selective Multi-Track Inclusion:** Checkboxes to select arbitrary combinations of audio tracks into the final output video.
3. **Per-Track Volume & Boost:** Replace discrete volume dropdown with dynamic sliders (0% to 200%, where >100% applies dB gain boost).
4. **Timeline-Aligned Waveform Lanes:** Visual amplitude lanes under the timeline displaying audio activity and silence gaps per track to assist trimming.
5. **Real-Time Synchronized Preview:** Web Audio API pipeline playing the selected track mix with instant volume slider response locked to video playback.
6. **Single-Track Usability:** Single-track videos show a compact volume slider inline on the bottom bar without requiring drawer expansion.

---

## 2. Architecture & Data Model

### 2.1 Store Types (`src/store.ts`)

```typescript
export type TrackInfo = {
  index: number;
  name: string;        // "Desktop Audio", "Mic / Aux", or fallback "Track 1"
  enabled: boolean;     // Included in export mix
  volume: number;      // 0.0 to 2.0 (1.0 = 100%, 1.4 = 140% / +3dB)
  muted: boolean;      // Mute toggle in preview & export
};

export type FileState = VideoFile & {
  // Existing fields...
  trims: Trim[];
  speedRanges: SpeedRange[];
  audio: AudioOpt;       // Kept for backward compatibility
  audioSource: AudioSource;
  normalize: boolean;
  
  // New multi-track configuration:
  audioTracksInfo: TrackInfo[];
};
```

### 2.2 Probe Metadata Parsing (`src-tauri/src/commands.rs`)

When probing files (`probe_files`), parse stream metadata headers:
- Parse stream metadata `title` or `handler_name` under each `Stream #0:X: Audio:`.
- If missing, fallback to `"Track {i + 1}"`.
- **Smart OBS Defaults:**
  - If track titles contain `"Master"` or `"Mix"`, enable only Track 1 by default.
  - If tracks denote distinct sources (e.g., `"Desktop"`, `"Mic"`, `"Game"`), enable all primary recognized sources (Track 1 & Track 2) by default at 100% volume.
  - For files without metadata titles, enable Track 1 by default at 100% volume.

---

## 3. Audio Extraction & Web Audio Preview Pipeline

### 3.1 Background Audio Extraction (`extract_track_audio`)
- Invoked lazily when the user expands the Audio Drawer in Trim Editor.
- Rust command invokes FFmpeg to demux audio streams into lightweight AAC (96kbps) files stored in the session cache:
  ```bash
  ffmpeg -y -i <input_path> -map 0:a:{idx} -vn -c:a aac -b:a 96k <cache_dir>/track_{idx}.m4a
  ```
- Command returns array of local file paths, exposed via Tauri asset protocol (`convertFileSrc`).

### 3.2 Waveform Peak Extraction (`src/audio/waveform.ts`)
- Client fetches the demuxed audio file and decodes it via `AudioContext.decodeAudioData`.
- Downsamples PCM data into 250–500 buckets across clip duration.
- Computes RMS and peak values per bucket (0.0 to 1.0).
- Renders SVG paths:
  - Amplitude < 0.02 renders as a flat baseline (silence).
  - Amplitude ≥ 0.02 renders vertical bars or smoothed wave curves.
  - Overlay mirrors the main timeline's cyan playhead line.

### 3.3 Live Preview Audio Graph (`src/audio/mixer.ts`)
- Video element audio is muted during multi-track preview (`video.muted = true`) to prevent phase issues or audio drift.
- Web Audio `AudioContext` maintains:
  - One `AudioBufferSourceNode` per active track.
  - Each source connects to a dedicated `GainNode` (controlled by track slider / mute).
  - All `GainNode`s sum into master destination (`ctx.destination`).
- Synchronization:
  - `video.onplay`: starts audio source nodes at `video.currentTime`.
  - `video.onpause` / `video.onseeked`: stops audio source nodes, reschedules for current time.
  - Slider adjustments call `gainNode.gain.setValueAtTime(vol, ctx.currentTime)` with zero latency and no playback interruption.

---

## 4. UI Design & Layout

### 4.1 Expandable Audio Drawer (`src/AudioDrawer.tsx`)
- Placed directly beneath the main range scrubber inside Trim Editor.
- Toggled via `[🎚️ Audio Tracks (N selected)]` button on bottom control bar.
- Layout: Stacked Timeline-Aligned Lanes (Layout 1):
  - Each track lane has:
    - Checkbox (Enable/Disable in export)
    - Track title badge with OBS name
    - Volume slider (0%–200%) with numerical percentage display (values >100% highlighted in amber)
    - Mute button
    - Waveform canvas/SVG directly aligned with the master timeline width above it.

### 4.2 Single-Track Video UI
- When video has only 1 audio stream:
  - Bottom bar replaces discrete dropdown with an inline slider: `Volume: 100% [----|----]`.
  - Audio drawer toggle is hidden (or optional for inspecting waveform).

---

## 5. FFmpeg Export Filtergraph

### 5.1 Standard Export (`src-tauri/src/commands.rs` & `src/engine/args.ts`)
- If 0 tracks enabled: pass `-an` (mute).
- If 1 track enabled (`trackIndex`, `volume`):
  ```
  -filter_complex "[0:a:{idx}]volume={vol}{loudnorm}[aout]" -map "[aout]"
  ```
- If N ≥ 2 tracks enabled:
  ```
  -filter_complex "[0:a:0]volume={v0}[a0];[0:a:1]volume={v1}[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0{loudnorm}[aout]" -map "[aout]"
  ```
- Audio is encoded as AAC stereo (`-c:a aac -q:a 2 -ar 48000 -ac 2`) for WhatsApp standard compatibility.

### 5.2 Speed Ramp Compatibility (`build_speed_filtergraph`)
- For speed ramps with multi-track audio:
  - The multi-track mix (`[amixed]`) is piped as input into the `atempo` time-stretching filtergraph for each fast-forward segment.
  - Preserves audio synchronization across all fast-forward segments.

---

## 6. Verification & Test Plan

1. **Rust Unit Tests (`src-tauri/src/commands.rs`):**
   - Test parsing stream metadata title from OBS ffmpeg stderr output.
   - Test fallback when metadata is missing.
   - Test filtergraph string generation with 1 track, 2 tracks with volume boosts, and mute.
2. **Frontend Unit Tests (`src/audio/args.test.ts` & `src/audio/waveform.test.ts`):**
   - Test audio filter string creation with various track configurations.
   - Test downsampling algorithm correctly identifies silence (<0.02) vs sound peaks.
3. **Manual / End-to-End Verification:**
   - Drop OBS multi-track recording (Desktop + Mic).
   - Verify track names "Desktop Audio" and "Mic / Aux" appear.
   - Adjust volume sliders; verify live audio volume changes during preview.
   - Check waveform peaks match speech in recording.
   - Export video and verify WhatsApp output file contains combined stereo audio mix.
