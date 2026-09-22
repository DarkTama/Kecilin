# Trim Editor Side Mixer, Theater Mode, and Proxy Resolution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Trim Editor to place the multi-track audio rack beside the video monitor (Option 1), add a ⛶ Theater mode toggle for a larger monitor view, make proxy preview resolution configurable (360p / 720p / 1080p) with transcode cost notifications, and keep audio waveforms full-width aligned under the master timeline scrubber.

**Architecture:** 
- Backend (`src-tauri/src/commands.rs`): Extend `prepare_preview` command to accept an optional `resolution: Option<u32>` (360, 720, 1080) and isolate cache keys per resolution so proxies don't collide.
- Engine bindings (`src/engine/`): Pass resolution through `preparePreviewProxy`.
- Audio UI (`src/AudioDrawer.tsx`): Decompose into an `AudioRack` (channel strips for volume/boost, mute, inclusion) and `WaveformLanes` (full-width timeline-aligned waveform ribbons).
- Trim Editor (`src/FileRow.tsx`): Implement the side-by-side grid layout (8 cols video, 4 cols audio rack), Theater mode expander (12 cols video, 380px tall), and a resolution selector menu with loading cost warnings.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Tauri 2, FFmpeg sidecar, Rust.

**Spec / Reference:**
- `docs/superpowers/specs/2026-09-21-multi-track-audio-design.md`
- `docs/superpowers/mockups/trim-editor-side-mixer-mockup.html`

## Global Constraints
- Target window size is 900×680 (minimum 720×540). The entire trim editor must remain usable without vertical page overflow.
- Full-width waveforms must maintain 1:1 pixel alignment with the master range scrubber above them.
- Native H.264/AAC videos stream directly from disk at 100% source quality without transcoding. Transcode proxies only generate for formats unsupported by Windows/WebView2 (HEVC, MKV, VP9, etc.).
- Audio preview mixer synchronization and FFmpeg filtergraph export must remain unaffected.

---

### Task 1: Backend Configurable Preview Proxy Resolution

**Files:**
- Modify: `src-tauri/src/commands.rs:1140-1265`
- Test: `src-tauri/src/commands.rs` (tests module)

**Interfaces:**
- Consumes: `AppHandle`, `path: String`, `resolution: Option<u32>`
- Produces: `pub async fn prepare_preview(app: AppHandle, path: String, resolution: Option<u32>) -> Result<String, String>`

- [ ] **Step 1: Write the failing unit test for resolution-isolated cache keys**

Add test in `src-tauri/src/commands.rs`:
```rust
#[test]
fn test_preview_cache_key_differs_by_resolution() {
    let key_360 = preview_cache_key("test.mkv", 1000, 2048, 360);
    let key_720 = preview_cache_key("test.mkv", 1000, 2048, 720);
    let key_1080 = preview_cache_key("test.mkv", 1000, 2048, 1080);
    assert_ne!(key_360, key_720);
    assert_ne!(key_720, key_1080);
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml test_preview_cache_key_differs_by_resolution`
Expected: FAIL with "cannot find function `preview_cache_key`"

- [ ] **Step 3: Implement resolution handling and cache key hashing in `src-tauri/src/commands.rs`**

```rust
pub(crate) fn preview_cache_key(path: &str, mtime: u64, size: u64, height: u32) -> String {
    format!("{path}|{mtime}|{size}|h={height}")
}
```
Update `prepare_preview`:
- Accept `resolution: Option<u32>`.
- Clamp target height to supported options: `let target_height = resolution.unwrap_or(360).clamp(240, 1080);`.
- Compute cache filename from `preview_cache_key`.
- In transcoding args, pass `-vf format!("scale=-2:{target_height}")`.

- [ ] **Step 4: Run backend tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (57+ tests)

- [ ] **Step 5: Commit Task 1**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(tauri): support configurable resolution in prepare_preview"
```

---

### Task 2: Engine API Bindings for Preview Resolution

**Files:**
- Modify: `src/engine/types.ts:119`
- Modify: `src/engine/tauri.ts:137-154`
- Modify: `src/engine/wasm.ts:315`

**Interfaces:**
- Consumes: `resolution?: number` in `preparePreviewProxy`
- Produces: `preparePreviewProxy(path: string, onProgress?: (percent: number) => void, resolution?: number): Promise<string>`

- [ ] **Step 1: Update type signature in `src/engine/types.ts`**

Update `preparePreviewProxy`:
```typescript
preparePreviewProxy(
  path: string,
  onProgress?: (percent: number) => void,
  resolution?: number,
): Promise<string>;
```

- [ ] **Step 2: Update Tauri invoke in `src/engine/tauri.ts`**

```typescript
preparePreviewProxy: async (path, onProgress, resolution) => {
  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<{ path: string; percent: number }>("preview-progress", (e) => {
      if (e.payload.path === path) {
        onProgress(e.payload.percent);
      }
    });
  }
  try {
    const p = await invoke<string>("prepare_preview", { path, resolution });
    return convertFileSrc(p);
  } finally {
    if (unlisten) {
      unlisten();
    }
  }
},
```

- [ ] **Step 3: Update dummy signature in `src/engine/wasm.ts`**

```typescript
preparePreviewProxy: () => Promise.reject(new Error("web engine: preview proxy unsupported")),
```

- [ ] **Step 4: Run typecheck and frontend tests**

Run: `npx tsc --noEmit && npm test -- --run`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/engine/types.ts src/engine/tauri.ts src/engine/wasm.ts
git commit -m "feat(engine): add resolution parameter to preparePreviewProxy"
```

---

### Task 3: Decompose `AudioDrawer` into Modular `AudioRack` & `WaveformLanes`

**Files:**
- Modify: `src/AudioDrawer.tsx`
- Test: `src/AudioDrawer.test.tsx`

**Interfaces:**
- Consumes: `file: FileState`, `playhead: number | null`, `onTrackChange: (index: number, patch: Partial<TrackInfo>) => void`, `waveforms?: Map<number, Float32Array>`
- Produces: 
  - `AudioRack`: compact channel strips to place beside the video monitor.
  - `WaveformLanes`: full-width waveform lanes aligned directly with the master timeline.
  - `AudioDrawer`: composite export maintaining backwards compatibility.

- [ ] **Step 1: Write test for separated AudioRack and WaveformLanes**

In `src/AudioDrawer.test.tsx`, add test cases verifying `AudioRack` renders track controls and `WaveformLanes` renders full-width SVG peaks:
```tsx
it("renders AudioRack with track volume sliders and mute toggles", () => {
  // test AudioRack
});
it("renders WaveformLanes with playhead indicator", () => {
  // test WaveformLanes
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- src/AudioDrawer.test.tsx --run`
Expected: FAIL on new exports.

- [ ] **Step 3: Implement `AudioRack` and `WaveformLanes` in `src/AudioDrawer.tsx`**

1. Extract `AudioRack`:
   - Contains track name badge, volume slider (0-200% with amber boost >100%), mute button, and enable checkbox.
   - Fits neatly in a 280px tall side container with scrollable track list when >3 tracks exist.
2. Extract `WaveformLanes`:
   - Full width horizontal SVG ribbons per track.
   - Shows cyan playhead slice across all lanes matching master timeline scrubber.
3. Keep `AudioDrawer` as default composite wrapper for seamless fallback.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/AudioDrawer.test.tsx --run`
Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/AudioDrawer.tsx src/AudioDrawer.test.tsx
git commit -m "refactor(ui): split AudioDrawer into modular AudioRack and WaveformLanes"
```

---

### Task 4: Integrate Side Mixer, Theater Mode & Resolution Selector in `FileRow.tsx`

**Files:**
- Modify: `src/FileRow.tsx`
- Modify: `src/i18n.ts` (add translation keys for theater mode, resolution, cost notice)

**Interfaces:**
- Consumes: `AudioRack`, `WaveformLanes`, `preparePreviewProxy(path, onProgress, resolution)`
- Produces: Updated Trim Editor with side-by-side layout (8 cols video, 4 cols audio rack), Theater mode button, resolution selector with transcode notification banner.

- [ ] **Step 1: Add i18n keys for theater mode and preview resolution**

In `src/i18n.ts`, add:
- `theaterMode`: "Theater mode" / "Mode bioskop"
- `standardMode`: "Standard mode" / "Mode standar"
- `previewQuality`: "Preview resolution" / "Resolusi pratinjau"
- `previewTranscodeNotice`: "Higher resolution increases proxy load time on non-native files (HEVC/MKV)" / "Resolusi lebih tinggi menambah waktu muat proksi untuk file non-native (HEVC/MKV)"
- `fast`: "Fast" / "Cepat"
- `balanced`: "Balanced" / "Seimbang"
- `highQuality`: "High Quality" / "Kualitas tinggi"

- [ ] **Step 2: Update Trim Editor state in `src/FileRow.tsx`**

Add states:
```typescript
const [theaterMode, setTheaterMode] = useState(false);
const [previewRes, setPreviewRes] = useState<360 | 720 | 1080>(720);
const [resMenuOpen, setResMenuOpen] = useState(false);
```

- [ ] **Step 3: Update `fallbackToProxy` in `src/FileRow.tsx` to pass `previewRes`**

```typescript
async function fallbackToProxy(targetRes = previewRes) {
  if (triedProxy.current && preview === "proxy" && targetRes === previewRes) return;
  setPreview("preparing");
  setProxyProgress(0);
  try {
    const url = await engine.preparePreviewProxy(
      file.path,
      (pct) => setProxyProgress(pct),
      targetRes,
    );
    setSrc(url);
    setPreview("proxy");
  } catch {
    setPreview("none");
  }
}
```

- [ ] **Step 4: Update JSX layout in `FileRow.tsx`**

1. Top row grid:
   - When `isMultiTrack && audioDrawerOpen`:
     - Grid layout: `grid grid-cols-1 md:grid-cols-12 gap-3`.
     - Video container: `theaterMode ? "md:col-span-12 h-[380px]" : "md:col-span-8 h-[280px]"` with `object-contain`.
     - Side Audio Rack: `theaterMode ? "md:col-span-12" : "md:col-span-4 h-[280px]"`.
   - When single track or drawer closed: Video container stays full-width.
2. Top controls over video:
   - Resolution dropdown button: shows `360p` / `720p` / `1080p` with cost badge and transcode notice.
   - Theater mode button: `[⛶ Theater]` / `[⛷️ Standard]` toggles `theaterMode`.
3. Middle row:
   - Master timeline scrubber.
   - `WaveformLanes`: renders full width directly under scrubber.
4. Bottom bar:
   - Standard Kecilin controls preserved.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx tsc --noEmit && npm test -- --run`
Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/FileRow.tsx src/i18n.ts
git commit -m "feat(ui): implement side-by-side audio rack, theater mode, and preview resolution selector"
```

---

### Task 5: End-to-End Verification and Test Suite Validation

**Files:**
- Verify: Full codebase

- [ ] **Step 1: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 57+ tests pass, 0 warnings.

- [ ] **Step 2: Run frontend test suites**

Run: `npm test -- --run`
Expected: All test suites pass.

- [ ] **Step 3: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Final verification commit if needed**

```bash
git status
```
Ensure working tree is clean.
