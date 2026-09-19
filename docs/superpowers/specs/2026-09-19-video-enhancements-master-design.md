# Video Enhancements Master Design Spec

- **Date**: 2026-09-19
- **Status**: Approved
- **Scope**: Architectural
- **Target Repository**: Kecilin (Tauri 2 + React 19 + bundled ffmpeg)

---

## 1. Vision & Purpose

Kecilin is a lightweight desktop app for compressing and splitting videos to fit WhatsApp compatibility and file size limits without command-line flags or quality degradation.

This specification unifies eight core user enhancements into a cohesive, single-pass pipeline:
1. **Persistent Custom Length**: Restores last custom split seconds across sessions.
2. **Safe Source Video Deletion**: Moves source file to OS Recycle Bin after verified conversion success.
3. **"Apply to All" Batch Actions**: One-click distribution of audio and split settings across queued files.
4. **One-Click Auto-Split**: Instantly slices entire video duration into fixed consecutive chunks (e.g. 30s Status parts).
5. **Custom Output File Naming**: Configurable template patterns with replacement tokens.
6. **Low CPU Priority Mode**: Runs ffmpeg sidecar at `BELOW_NORMAL_PRIORITY_CLASS` on Windows to keep system responsive.
7. **Metadata Stripping**: Enforces `-map_metadata -1` to wipe GPS, camera, and device tags for privacy.
8. **Range Speed-Up / Fast-Forward**: Allows accelerating a designated sub-interval of the video, with `atempo` audio sync, dynamic timeline duration calculation, and target duration fitting.

---

## 2. Architecture & Data Structures

### 2.1 State & Persistence (`src/store.ts`)

```typescript
export type SpeedRange = {
  start: number;           // start timestamp in seconds
  end: number;             // end timestamp in seconds
  speed: number;           // multiplier: e.g. 1.25, 1.5, 2.0, 4.0, 8.0
  fitTarget: boolean;      // true if speed is solved from targetDuration
  targetDuration?: number; // target duration for the total output in seconds
};

export type FileState = VideoFile & {
  trims: Trim[];
  speedRange: SpeedRange | null;
  audio: AudioOpt;
  audioSource: AudioSource;
  normalize: boolean;
  outputs: OutputFile[];
  status: FileStatus;
  percent: number;
  error: string | null;
};
```

#### Persisted Preferences in `kecilin-prefs`
The following keys are stored in `localStorage` via Zustand `persist`:
- `lastCustomLen: number` (default: `15`)
- `lowCpuPriority: boolean` (default: `false`)
- `stripMetadata: boolean` (default: `true`)
- `namingPattern: string` (default: `"{name}_whatsapp_{preset}{part}"`)
- `deleteSourceToTrash: boolean` (default: `false`)

---

## 3. ffmpeg Argument & Filtergraph Engine

Both Rust (`src-tauri/src/commands.rs`) and TypeScript (`src/engine/args.ts`) engines must implement identical argument generation.

### 3.1 Metadata Stripping
When `stripMetadata` is `true`:
- Append `-map_metadata -1` to output arguments.

### 3.2 Output Naming Engine
Supported replacement tokens:
- `{name}` or `{stem}`: Input filename without extension.
- `{preset}`: Preset slug (`360p`, `480p`, `720p`, or custom slug).
- `{part}`: `_part1`, `_part2` if part index $\ge 1$; empty string for single output.
- `{resolution}`: Height in pixels (e.g. `480p`).
- `{date}`: Current date formatted as `YYYYMMDD`.

Sanitization replaces characters `[\\/:*?"<>|]` with `_`. If multiple parts exist but `{part}` is missing from the template, `_partN` is automatically suffixed to prevent overwriting.

### 3.3 Range Speed-Up Filtergraph Construction

Given source clip range $[T_{start}, T_{end}]$ and active speed range $[S_{start}, S_{end}]$ with multiplier $S$:

#### Case 1: Full-Clip Acceleration ($S_{start} = T_{start}$ and $S_{end} = T_{end}$)
- Video filter: `-vf "scale=-2:${height}:flags=lanczos,setpts=PTS/${S}"`
- Audio filter: `-af "${atempo_chain}"`

#### Case 2: Sub-Range Acceleration ($T_{start} \le S_{start} < S_{end} \le T_{end}$)
Single-pass `-filter_complex` with 3 segments:
1. **Pre-speed segment** $[T_{start}, S_{start}]$:
   ```text
   [0:v]trim=start=T_start:end=S_start,setpts=PTS-STARTPTS,scale=-2:${height}:flags=lanczos[v0];
   [0:a]atrim=start=T_start:end=S_start,asetpts=PTS-STARTPTS[a0];
   ```
2. **Sped segment** $[S_{start}, S_{end}]$:
   ```text
   [0:v]trim=start=S_start:end=S_end,setpts=PTS-STARTPTS,setpts=PTS/${S},scale=-2:${height}:flags=lanczos[v1];
   [0:a]atrim=start=S_start:end=S_end,asetpts=PTS-STARTPTS,${atempo_chain}[a1];
   ```
3. **Post-speed segment** $[S_{end}, T_{end}]$:
   ```text
   [0:v]trim=start=S_end:end=T_end,setpts=PTS-STARTPTS,scale=-2:${height}:flags=lanczos[v2];
   [0:a]atrim=start=S_end:end=T_end,asetpts=PTS-STARTPTS[a2];
   ```
4. **Stitch**:
   ```text
   [v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vcat][acat]
   ```
   If audio normalization is enabled, `loudnorm` is appended to `[acat]`.

#### `atempo` Rules & Audio Protection
- FFmpeg's `atempo` is bounded between $0.5$ and $2.0$.
- For $S > 2.0$, chain filters:
  - $2\times$: `atempo=2.0`
  - $4\times$: `atempo=2.0,atempo=2.0`
  - $8\times$: `atempo=2.0,atempo=2.0,atempo=2.0`
- When $S > 4.0$, audio can optionally be muted (`-an` on the fast segment) to avoid extreme high-frequency acoustic artifacts.

#### Duration Calculation & Target Fit
- **Effective Output Duration**:
  $$D_{out} = (S_{start} - T_{start}) + \frac{S_{end} - S_{start}}{S} + (T_{end} - S_{end})$$
- **Target Fitting Solver**:
  With target duration $L_{target}$ and unaccelerated duration $T_{fixed} = (S_{start} - T_{start}) + (T_{end} - S_{end})$:
  $$S = \frac{S_{end} - S_{start}}{L_{target} - T_{fixed}}$$
  $S$ is clamped to $[1.05, 30.0]$.

---

## 4. Backend & OS Integration

### 4.1 Process Priority (`src-tauri/src/commands.rs`)
On Windows, spawn ffmpeg with creation flags:
```rust
#[cfg(target_os = "windows")]
{
    use std::os::windows::process::CommandExt;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
    if options.low_priority {
        cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS);
    }
}
```

### 4.2 Safe Source Deletion
- Depend on `trash = "5"` in `src-tauri/Cargo.toml`.
- Strict execution safety sequence:
  1. Setting `deleteSourceToTrash` must be enabled.
  2. File conversion status must be `done` with exit code `0`.
  3. Output file exists on disk and has byte size $> 0$.
  4. Call `trash::delete(&source_path)`.
  5. Any trash failure is logged and surfaced as a non-fatal warning; the batch does not halt.

---

## 5. UI Components & User Flow

### 5.1 Batch Actions Toolbar (`src/App.tsx`)
Displayed above file list when queue has $\ge 2$ items:
- **Copy Audio Settings**: Propagate current file's audio track, mute, volume, and normalization to all rows.
- **Auto-Split All**: Apply fixed or custom length auto-split across all queued files.
- **Clear All Trims**: Reset queue to full-length videos.

### 5.2 Trim & Speed Editor (`src/FileRow.tsx`)
- **One-Click Auto-Split**: Button calculates and sets contiguous segments $[0 \dots L], [L \dots 2L] \dots$ up to video duration.
- **Speed Ramp UI**:
  - Secondary highlighted range on slider representing $[S_{start}, S_{end}]$.
  - Speed selector buttons: `1.5x`, `2x`, `4x`, `8x`.
  - Toggle between **Fixed Speed Multiplier** and **Fit Target Duration**.
  - Live duration indicator comparing original vs output duration.

### 5.3 Advanced Settings Panel
- Low CPU Priority toggle.
- Strip Metadata toggle.
- Custom Naming Pattern input with tag helpers.
- "Move source file to Recycle Bin on success" checkbox with confirmation dialog.

---

## 6. Error Handling & Edge Cases

| Scenario | Handling |
|---|---|
| Video has 0 audio streams | Omit `atrim`/`atempo` from filtergraph; map video only with `-an`. |
| Target duration $\le T_{fixed}$ | Reject target; clamp to $T_{fixed} + 0.5\text{s}$ and show inline warning. |
| Speed range outside trim | Clamp speed range to trim bounds: $T_{start} \le S_{start} < S_{end} \le T_{end}$. |
| Recycle Bin unavailable (SMB/network share) | Catch `trash::Error`, mark warning in batch summary, keep converted output. |
| Multi-part trim without `{part}` in template | Auto-append `_partN` to prevent file overwrite. |

---

## 7. Testing Strategy

1. **Unit Tests (`src/engine/args.test.ts`)**:
   - Verify `-map_metadata -1` presence when flag is set.
   - Test naming pattern parser with various token combinations.
   - Validate single-pass filtergraph strings for sub-range speedup, full speedup, and audio chain.
   - Test mathematical solver for target duration fitting.
2. **Rust Tests (`src-tauri/src/commands.rs`)**:
   - Ensure byte-for-byte argument parity with TypeScript tests.
   - Verify creation flag values under Windows target.
   - Validate pre-trash validation conditions.
3. **Integration / Manual Verification**:
   - Confirm video playback of sped section and audio pitch preservation.
   - Verify file is recoverable from Windows Recycle Bin after conversion.
   - Verify CPU usage remains non-intrusive when low priority mode is active.
