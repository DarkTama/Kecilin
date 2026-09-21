# Video Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver nine core enhancements to Kecilin: persistent custom split length, safe Recycle Bin deletion, batch apply-to-all controls, one-click auto split, customizable output naming (global pattern + per-trim direct renaming), Windows low CPU priority, privacy metadata stripping, range speed-up (fast-forward) with audio sync, and hardware-accelerated preview generation with live progress.

**Architecture:** 
- State: Persist user preferences in Zustand store (`localStorage`), extend `Trim` with optional `customName`, and add `SpeedRange` model.
- Engine: Pure functional argument builders (`src/engine/args.ts`) for token substitution and single-pass complex filtergraphs (`trim`, `setpts`, `atempo`, `concat`), strictly mirrored in Rust (`src-tauri/src/commands.rs`).
- Backend: Windows process priority flag (`BELOW_NORMAL_PRIORITY_CLASS`), `trash` crate safe source deletion, fast stream copy remux detection, and child process progress streaming with cancellation.
- UI: Studio-grade dark timeline deck (`src/FileRow.tsx`), amber speed velocity overlay, laser playhead, per-trim filename inputs, and queue-level batch toolbar (`src/App.tsx`).

**Tech Stack:** React 19, TypeScript 5.8, Zustand 5, Tailwind CSS 4, Tauri 2, Rust, FFmpeg / FFprobe sidecars.

**Spec:** `docs/superpowers/specs/2026-09-19-video-enhancements-master-design.md`

## Global Constraints

- Output video format: H.264 MP4 with YUV420p pixel format and AAC audio for WhatsApp compatibility.
- FFmpeg single pass: Avoid multi-encode intermediate files when applying speedup, trim, scale, and loudnorm.
- Windows priority class: `BELOW_NORMAL_PRIORITY_CLASS = 0x00004000`.
- Safe file deletion: Only via OS trash/Recycle Bin (`trash` crate), never permanent `fs::remove_file` on source media.
- Internationalization: All new UI strings must support both English (`en`) and Indonesian (`id`) in `src/i18n.ts`.

---

### Task 1: Store & Engine Types

**Files:**
- Modify: `src/store.ts`
- Modify: `src/engine/types.ts`

**Interfaces:**
- Consumes: Existing `Trim`, `FileState`, `BatchOptions`.
- Produces:
  - `Trim.customName?: string`
  - `SpeedRange = { start: number; end: number; speed: number; fitTarget: boolean; targetDuration?: number }`
  - Persisted preferences: `lastCustomLen`, `lowCpuPriority`, `stripMetadata`, `namingPattern`, `deleteSourceToTrash`
  - Actions: `setLastCustomLen`, `setLowCpuPriority`, `setStripMetadata`, `setNamingPattern`, `setDeleteSourceToTrash`, `setSpeedRange`, `copyAudioToAll`, `autoSplitAll`, `clearAllTrims`

- [ ] **Step 1: Update type definitions in `src/store.ts` and `src/engine/types.ts`**
Add `customName?: string` to `Trim`. Define `SpeedRange`. Add `speedRange: SpeedRange | null` to `FileState` and `BatchItem`.

- [ ] **Step 2: Add preference keys to Zustand state and persistence whitelist**
Update `StoreState` interface with preference fields and action setters. In `persist` configuration `partialize`, include `lastCustomLen`, `lowCpuPriority`, `stripMetadata`, `namingPattern`, `deleteSourceToTrash`.

- [ ] **Step 3: Implement batch queue helper actions**
Add `copyAudioToAll(sourceIndex: number)`, `autoSplitAll(partSeconds: number)`, and `clearAllTrims()` to Zustand store actions.

- [ ] **Step 4: Typecheck store and engine types**
Run: `npx tsc --noEmit`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**
```bash
git add src/store.ts src/engine/types.ts
git commit -m "feat: add speed range, custom naming, and preference models to store"
```

---

### Task 2: Output Naming Engine (Template Tokens & Per-Trim Overrides)

**Files:**
- Modify: `src/engine/args.ts`
- Modify: `src/engine/args.test.ts`

**Interfaces:**
- Consumes: `outputName(srcPath, presetName, partIndex, template, customName)`
- Produces: Sanitized filename string ensuring `.mp4` extension.

- [ ] **Step 1: Write failing tests in `src/engine/args.test.ts`**
Test cases:
1. Global pattern with tokens `{name}`, `{preset}`, `{part}`, `{resolution}`, `{date}`.
2. Direct `customName` override ignores global pattern and sanitizes characters `[\\/:*?"<>|]`.
3. Ensures `.mp4` extension is retained or appended.
4. Auto-appends `_partN` if multiple parts exist but `{part}` token is omitted.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/engine/args.test.ts`
Expected: FAIL with missing template support or argument mismatch.

- [ ] **Step 3: Implement naming engine in `src/engine/args.ts`**
Implement `resolveOutputFilename(stem: string, presetName: string, height: number, part: number | null, totalParts: number, pattern: string, customName?: string): string`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/engine/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/engine/args.ts src/engine/args.test.ts
git commit -m "feat: implement template-based and per-trim output filename resolution"
```

---

### Task 3: Filtergraph Engine for Range Speed-Up (Fast Forward)

**Files:**
- Modify: `src/engine/args.ts`
- Modify: `src/engine/args.test.ts`

**Interfaces:**
- Consumes: `SpeedRange`, `Trim`, `PresetSpec`, `AudioOpt`, `AudioSource`, `normalize`.
- Produces:
  - `buildFfmpegArgs(...)` updated with `-filter_complex` when `speedRange` active or `-map_metadata -1` when `stripMetadata` true.
  - Duration calculation & target solver functions: `calculateEffectiveDuration`, `solveSpeedMultiplier`.

- [ ] **Step 1: Write failing tests in `src/engine/args.test.ts`**
Test cases:
1. Sub-range speedup produces 3-segment filtergraph (`[0:v]trim=...`, `[0:a]atrim=...`, `concat=n=3:v=1:a=1`).
2. Multiplier $> 2.0$ generates chained `atempo=2.0,atempo=...` filters.
3. Multiplier $> 4.0$ mutes audio on sped segment if audio would glitch.
4. Video with no audio drops audio trim segments gracefully.
5. Metadata stripping appends `-map_metadata`, `-1`.
6. Target duration solver accurately computes speed multiplier $S$.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/engine/args.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement filtergraph builder and duration solver in `src/engine/args.ts`**
Write `buildSpeedFiltergraph`, `buildAtempoChain`, `calculateEffectiveDuration`, and `solveSpeedMultiplier`. Wire into `buildFfmpegArgs`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/engine/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/engine/args.ts src/engine/args.test.ts
git commit -m "feat: implement single-pass filtergraph builder for sub-range speedup"
```

---

### Task 4: Tauri Backend OS Integration (Windows Priority, Trash, Parity)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `BatchOptions` with `low_priority`, `strip_metadata`, `naming_template`, `delete_source_to_trash`.
- Produces:
  - Low priority process creation on Windows (`creation_flags(0x00004000)`).
  - Post-batch safe source deletion via `trash::delete(&item.path)`.
  - Filtergraph argument generation matching TypeScript engine.

- [ ] **Step 1: Add `trash = "5"` dependency to `src-tauri/Cargo.toml`**
Add `trash = "5"` under `[dependencies]`.

- [ ] **Step 2: Update Rust structs in `src-tauri/src/commands.rs`**
Add `custom_name: Option<String>` to `Trim`. Add `SpeedRange` struct and field on `BatchItem`. Add `low_priority`, `strip_metadata`, `naming_template`, `delete_source_to_trash` to `BatchOptions`.

- [ ] **Step 3: Implement Windows creation flags and metadata stripping in FFmpeg runner**
In `ffmpeg_cmd()` or execution loop, inject `BELOW_NORMAL_PRIORITY_CLASS` when `opts.low_priority` is true on Windows. Inject `-map_metadata -1` when `opts.strip_metadata` is true.

- [ ] **Step 4: Implement verified safe deletion**
After all parts of a file convert with exit code 0 and non-empty outputs on disk, if `opts.delete_source_to_trash` is true, invoke `trash::delete(Path::new(&item.path))`. Catch errors non-fatally.

- [ ] **Step 5: Verify Rust compiles**
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS with no errors.

- [ ] **Step 6: Commit**
```bash
git add src-tauri/Cargo.toml src-tauri/src/commands.rs
git commit -m "feat: add Windows low priority, metadata stripping, and trash integration to Tauri backend"
```

---

### Task 5: Smart Preview Optimization (Stream Copy Remux, HW Accel & Progress)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/engine/tauri.ts`
- Modify: `src/engine/types.ts`
- Modify: `src/FileRow.tsx`

**Interfaces:**
- Consumes: `engine.preparePreviewProxy(path, onProgress, abortSignal)`
- Produces:
  - Instant stream copy remux (`-c copy`) for H.264+AAC MKV/MOV.
  - `-hwaccel auto` decode acceleration.
  - Real-time `preview-progress` events streamed to React state.
  - `cancel_preview(path)` command.

- [ ] **Step 1: Enhance `prepare_preview` in `src-tauri/src/commands.rs`**
Check probe data: if video codec is `h264` and audio is `aac`, run `-c copy` to MP4 (sub-second remux). Otherwise, run preview encode with `-hwaccel auto`, `-progress pipe:1`, and emit `preview-progress` events. Store child PID in `Arc<Mutex<HashMap<String, u32>>>` so `cancel_preview` can kill it.

- [ ] **Step 2: Add `cancel_preview` Tauri command**
Add command to `commands.rs` and register in `lib.rs`.

- [ ] **Step 3: Update `src/engine/tauri.ts` and `src/engine/types.ts`**
Expose `onPreviewProgress` listener and `cancelPreviewProxy(path)`.

- [ ] **Step 4: Update Preview UI in `src/FileRow.tsx`**
Replace static text with active progress card: determinate progress bar, percentage display, hardware acceleration badge, and `Cancel` button.

- [ ] **Step 5: Verify and build**
Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/engine/types.ts src/engine/tauri.ts src/FileRow.tsx
git commit -m "feat: implement smart preview remux, hwaccel, and real-time progress card"
```

---

### Task 6: Timeline Scrubber & Speed Ramp UI Redesign

**Files:**
- Modify: `src/FileRow.tsx`

**Interfaces:**
- Consumes: `RangeSlider` with enhanced props (`speedRange`, `onSpeedRangeChange`, active parts).
- Produces:
  - 20px precision timeline with highlighted active trim zones and amber speed ramp intervals.
  - Laser playhead with hover timestamp tooltip.
  - Frame-step nudge buttons.
  - Inline per-trim output filename input for single trims and part chips.
  - Speed ramp configuration panel (Multiplier selector: 1.5x, 2x, 4x, 8x, and Target Duration solver).

- [ ] **Step 1: Redesign `RangeSlider` component**
Expand track height to 20px. Add multi-segment visualization:
- Render active trim ranges in emerald (`bg-emerald-500/80`).
- Render speed ramp sub-interval in amber diagonal stripes (`bg-amber-500/70`).
- Render playhead as cyan needle with current time badge.

- [ ] **Step 2: Add Speed Ramp controls deck in `FileRow.tsx`**
Add toggle checkbox "Fast Forward (Speed-Up)". When enabled, show speed range inputs, multiplier pills (`1.5x`, `2x`, `4x`, `8x`), target duration solver input, and live net duration summary.

- [ ] **Step 3: Implement per-trim output filename editor**
Add inline editable text input for the destination filename in the trim bar. In multi-part mode, render editable badge/input on each part chip.

- [ ] **Step 4: Wire persistent custom length**
Connect `customLen` input to `s.lastCustomLen` and update store on change so user's preferred custom length is retained across files and sessions.

- [ ] **Step 5: Verify in browser preview / typecheck**
Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/FileRow.tsx
git commit -m "feat: upgrade timeline scrubber with speed ramp deck and per-trim filename editor"
```

---

### Task 7: Batch Toolbar & Auto-Split All Action

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/i18n.ts`

**Interfaces:**
- Consumes: Store actions `autoSplitAll`, `copyAudioToAll`, `clearAllTrims`.
- Produces: Header batch bar above file queue when queue length $\ge 2$.

- [ ] **Step 1: Add i18n keys to `src/i18n.ts`**
Add English and Indonesian strings for:
- `batchToolbarTitle`, `copyAudioAll`, `autoSplitAll30`, `autoSplitAllCustom`, `clearAllTrims`, `audioCopiedToast`.

- [ ] **Step 2: Build `BatchToolbar` component in `src/App.tsx`**
Render compact banner above `FileRow` list when `s.files.length >= 2` and not converting:
- `⚡ Split All: 30s Status` button.
- `Copy Audio to All` button.
- `Clear All Trims` button.

- [ ] **Step 3: Wire store actions to toolbar buttons**
Trigger `s.autoSplitAll(30)`, `s.copyAudioToAll(0)`, and `s.clearAllTrims()`.

- [ ] **Step 4: Typecheck and test**
Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/App.tsx src/i18n.ts
git commit -m "feat: add batch operations toolbar with auto-split and audio sync"
```

---

### Task 8: Advanced Settings & Safe Recycle Bin UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/i18n.ts`

**Interfaces:**
- Consumes: Store preferences `lowCpuPriority`, `stripMetadata`, `namingPattern`, `deleteSourceToTrash`.
- Produces: Advanced settings UI controls with confirmation dialog for Recycle Bin deletion.

- [ ] **Step 1: Add i18n keys to `src/i18n.ts`**
Add English and Indonesian strings for:
- `lowCpuPriorityLabel`, `lowCpuPriorityHint`, `stripMetadataLabel`, `stripMetadataHint`, `namingPatternLabel`, `namingPatternHint`, `deleteSourceLabel`, `deleteSourceWarnTitle`, `deleteSourceWarnBody`, `confirmEnable`.

- [ ] **Step 2: Add controls to Advanced Panel in `src/App.tsx`**
- Low CPU Priority toggle switch.
- Strip Metadata toggle switch.
- Naming Pattern text input with token helper pills (`{name}`, `{preset}`, `{part}`, `{resolution}`, `{date}`) that insert token on click.
- "Move source file to Recycle Bin after conversion" checkbox with confirmation dialog before enabling.

- [ ] **Step 3: Connect settings to `engine.startBatch` payload**
Ensure `lowPriority`, `stripMetadata`, `namingTemplate`, and `deleteSourceToTrash` are passed down to engine invocation.

- [ ] **Step 4: Typecheck and test**
Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/App.tsx src/i18n.ts
git commit -m "feat: add advanced settings for priority, metadata stripping, naming pattern, and trash"
```

---

### Task 9: End-to-End Build & Verification

**Files:**
- Verify: Full codebase

- [ ] **Step 1: Install dependencies and run tests**
Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Build frontend assets**
Run: `npm run build`
Expected: Clean Vite + TypeScript build with zero errors.

- [ ] **Step 3: Check Rust compilation**
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Clean check with no errors or warnings.

- [ ] **Step 4: Final verification and commit**
```bash
git add .
git commit -m "chore: verify all video enhancement features pass build and test suite"
```
