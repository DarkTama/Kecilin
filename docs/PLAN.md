# Plan — Kecilin

_Planning doc. Last updated: 2026-08-24. Sibling project: [AnyLeap](../../screen-recorder/docs/PLAN.md) — same stack, same doc structure, same sidecar playbook._

## Vision

One click from "folder of videos" to "WhatsApp-ready copies": pick a folder, pick a preset, convert. Output survives WhatsApp without being mangled — no command line, no flags, ever.

## Problem

- WhatsApp aggressively re-compresses video; large or high-bitrate uploads arrive blocky, stuttery, or fail outright.
- The encode is already solved: [`compress.bat`](../compress.bat) produces excellent WhatsApp-compatible output. But it's CLI-only — no progress, no file list, presets picked by typing a number, unusable by anyone non-technical.
- The GUI's job is **not** to invent a better encode. It's to give the proven one a face.

## Goals

1. **Zero command line** — folder picker, three preset buttons, one Convert button.
2. **Keep the proven encode** — reproduce `compress.bat`'s ffmpeg invocation exactly (see [ARCHITECTURE.md](ARCHITECTURE.md)); no quality regression, ever.
3. **Visible progress** — per-file and whole-batch progress bars; failures reported without stopping the batch.
4. **Self-contained** — ffmpeg bundled as a Tauri sidecar; user installs nothing.

## Core architectural decisions (settled)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Engine | **ffmpeg CLI as-is** (sidecar) | Encode already proven in `compress.bat`; never reimplement video. |
| App framework | **Tauri 2** (Rust core + web UI) | Same stack as AnyLeap; small binary, thin backend, Windows-first. |
| Frontend | **React 19 + Tailwind v4 + Zustand** | Simple queue/progress UI; Zustand mirrors backend events. |
| Presets | **3 fixed presets, no knobs** (v1) | Matches the script. Knob soup is what we're escaping. |
| Concurrency | **Sequential** (v1) | Matches the script; `libx264 -preset slow` already saturates the CPU. |

## Scope

### v1 — "The .bat, with a face"

- Pick a source folder via the Tauri dialog.
- Scan top level (non-recursive, same as the script) for `.mp4` `.mov` `.mkv` `.avi` `.webm`.
- Preset picker with the script's plain-language labels: **360p** (small, long clips), **480p** (balanced), **720p** (gameplay-friendly).
- **Optional per-file trim** (the one v1 feature the script didn't have): drag two handles on a timeline to set start/end — typed timestamps as fallback. Only the trimmed range is converted. See [ARCHITECTURE.md](ARCHITECTURE.md#trimming).
- Queue list; per-file + batch progress bars; failed files marked but batch continues (script behavior).
- Output to `whatsapp_{preset}` subfolder inside the source, `{name}_whatsapp_{preset}.mp4` naming — identical to the script.
- Cancel the batch mid-run.
- Sidecar self-check on launch (run `ffmpeg -version`, surface a clear error if broken).

### v1.x — quality of life (shipped in v0.2.0)

- ✅ **Trim preview controls** — a pause/resume button on the preview, and a playhead marker: the current second as a moving line on the range slider plus a numeric time readout.
- ✅ **Pick individual files** — convert chosen files, not only a whole folder: a file picker next to the folder picker; the queue mixes both. (Drag-and-drop onto the window stays v2.)
- ✅ **Custom output folder** — optional override for where converted files land; the default stays `whatsapp_{preset}` inside the source folder (the script contract).

### v2 (shipped in v0.3.0)

- ✅ **Universal preview** — when the webview can't decode a file (HEVC without Windows' codec extension, `.mkv`, `.avi`, …) the app re-encodes a small cached H.264/360p proxy with the bundled ffmpeg and previews that. Detection: `onError` plus `videoWidth === 0` after metadata (the audio-plays-video-black case). Cache in the app cache dir, keyed by path+mtime+size, wiped after 7 days on launch.
- ✅ **Per-file preview** — a thumbnail for every queue row (one cached ffmpeg frame grab, extracted sequentially) that opens the preview/trim panel on click.
- ✅ **Multi-part trim** — the trim editor holds a list of ranges ("+ Add part"); each range is its own ffmpeg run (the `-ss`/`-t` invocation unchanged), output as `{name}_whatsapp_{preset}_part1.mp4`, `_part2`, … One range keeps the plain (no suffix) name. The row's progress bar aggregates across the file's parts.
- ✅ Drag-and-drop videos onto the window (mixes with folder scans and the file picker).

### QoL rounds 2 + 3 (shipped in v0.4.0)

- ✅ **Remove from queue** — × on each row, plus "Clear queue" in the header.
- ✅ **Version info in the app** — footer with the current version and a releases link; pairs with the launch update check.
- ✅ **Result stats** — done rows show savings ("✓ −88%", sizes in the tooltip); the batch summary totals space saved. Backed by `outputs` (path + size) on the `file:done` event.
- ✅ **Reveal converted file** — "Show" on a done row opens its output in Explorer.
- ✅ **Batch-finished notification** — Windows toast when the batch ends unfocused (skipped on cancel).
- ✅ **Remember preferences** — preset + output folder via zustand `persist` (localStorage; no store plugin needed); window size/position via `tauri-plugin-window-state`.
- ✅ **Fixed-length parts ("Status mode")** — Part length: Free / 30 s / custom; the selection becomes a fixed window you slide, "+ Add part" stamps it and auto-advances to the next window.
- ✅ **Size guidance** — per-preset ceiling on the cards ("≤ ~40 MB", maxrate + audio × encoded seconds, trims respected) with a "fits 64 MB ✓" flag.
- ✅ **Audio: mute or turn down** — per-file (keep/75/50/25/mute) in the trim panel; mute drops the track (`-an`), reductions use `-af volume=`.
- ✅ **Hand off results** — drag the done row's thumbnail out of the app (tauri-plugin-drag; multi-part drags all parts), or "Copy" puts the file(s) on the clipboard via `clipboard-win` for Ctrl+V.
- ✅ **Trim precision** — arrow keys nudge the focused handle (Shift = 1 s), Space toggles play/pause, and clicking/dragging the timeline seeks the playhead anywhere — playback can start mid-video, outside the selection.

### Audio round (shipped in v0.5.0; requested by friends, spec vetted)

- **Audio track selection** — for OBS-style multi-track recordings (game audio vs mic). Scan detects the audio track count (count `Audio:` streams in the same ffmpeg header we already parse for duration; add `audioTracks` to the scan result); files with >1 track get a per-file **Audio source** dropdown: *Default / Track N / Merge all*. Selection maps `-map 0:a:{index}` — only detected indices are offered (a missing index hard-fails, so no free-typed numbers); default stays `-map 0:a?`.
- **Audio track merging** — the *Merge all* choice above. `-filter_complex "[0:a:0][0:a:1]amix=inputs=N:duration=longest:normalize=0[aout]" -map "[aout]"` — explicit input labels, mapped output, and `normalize=0` so amix doesn't quietly halve each source. Once `-filter_complex` is in play, volume/normalize chain *inside* it (not `-af`) — the arg builder owns that switch.
- **Normalize volume (auto-gain)** — one toggle, implemented with one-pass `loudnorm` (e.g. `I=-16:TP=-1.5:LRA=11`) for phone-friendly loudness; `dynaudnorm` is the fallback if loudnorm disappoints on speech. Chain order: amix → loudnorm → the existing volume option; mute wins over everything.

### Web version (shipped in v0.6.0): Kecilin on GitHub Pages

Two versions from one repo and one tag: the desktop Release (unchanged) **and** a static web app at <https://darktama.github.io/Kecilin/>. The friend-spec's server-side SaaS (upload → server ffmpeg → download → temp cleanup) was deliberately NOT built — Pages can't run servers, servers cost money, and uploads are a privacy regression. What shipped instead:

- ✅ **ffmpeg.wasm, fully client-side** — GPL core with libx264, same encode flags; videos never leave the visitor's browser. Nothing to clean up server-side.
- ✅ **Same UI, swappable engine** — `src/engine/` defines the interface; `tauri.ts` wraps the native commands, `wasm.ts` runs ffmpeg.wasm (WORKERFS-mounted inputs, MEMFS outputs → blob "Save" links, `terminate()` on cancel). `args.ts` mirrors the Rust arg builder byte-for-byte, held in sync by vitest (`args.test.ts` mirrors the Rust unit tests). Capabilities gate desktop-only affordances (reveal/copy/drag-out/output folder/folder scan hide on web; per-output Save links appear instead).
- ✅ **Performance honesty** — `veryfast` preset on web, a banner linking to Releases, multithreaded core via `coi-serviceworker` when the browser allows it, single-thread fallback otherwise (the fallback is e2e-verified; multi-GB files remain out of scope — wasm memory cap).
- Trim/multi-part/fixed-length/audio round/size guidance all work on web; proxy previews and folder scanning are desktop-only (thumbnails still work everywhere — wasm decodes even HEVC for the frame grab).
- ✅ **Deploy** — `.github/workflows/pages.yml` builds `vite --mode web` + copies the wasm runtime and deploys on every release tag.

### Later

- Parallel conversion (Tokio pool up to core count — mostly pays off for many short clips).
- **Skip current file** during a batch (in addition to Cancel-all) — one stuck/wrong file shouldn't cost the whole run.
- **ETA on the batch bar** — estimate remaining time from encode speed so far.
- Custom preset editor / advanced flags.
- Optional GPU encode (NVENC) for speed at some quality cost.
- Recursive folder scan; smarter overwrite policy (skip/ask instead of silent `-y`).
- **In-app auto-update** — download-and-install via the Tauri updater instead of today's notify-and-open-releases.
- **Bahasa Indonesia UI** — a language toggle; the app's audience (and name) is Indonesian.
- macOS / Linux builds.

### Non-goals

- **Not** a video editor beyond trimming/splitting — no crop, filters, or joining. (Multi-segment cuts moved to v2+ scope.)
- **Not** a WhatsApp client — no sending, no WhatsApp API; output files only.
- **Not** rebuilding any video pipeline — ffmpeg owns the encode.

## Success criteria (v1)

- A user picks a folder, clicks a preset, clicks Convert — zero other decisions required.
- Output is the same encode `compress.bat` produces (same flags, same naming, same folder layout).
- Progress is visible per file and per batch; one failed file doesn't kill the run.
- Trimming a clip means dragging two handles — no typing timestamps (typed input exists only as fallback).

## Milestones

1. ✅ **M0 — Docs & decisions**: plan, architecture, encode spec captured from `compress.bat`.
2. ✅ **M1 — Shell**: Tauri 2 + React/Vite boots; ffmpeg sidecar bundled via fetch script; self-check on launch.
3. ✅ **M2 — Pipeline**: `scan_directory` + one file converted end-to-end with real progress events.
4. ✅ **M3 — UI**: folder picker, preset picker, queue view, progress bars wired to events.
5. ✅ **M4 — Trim**: durations at scan time, per-file range slider (+ preview where the webview can play the format), `-ss`/`-t` wired into the encode.
6. ✅ **M5 — Polish**: cancel, failure states, batch summary, empty-folder handling.

## Known issues

- **RESOLVED (v0.3.0): trim preview black while audio plays on one machine.** Root cause: the files were OBS recordings encoded as **HEVC**; WebView2 only decodes HEVC when Windows' "HEVC Video Extensions" are present. The user's laptop has the OEM extension (previews fine, even for the very same file over SMB), the desktop doesn't (`videoWidth` stays 0, audio still plays, no error event — hence silent black before v0.2.1). Not a GPU/driver bug; v0.2.0's overlay flag and v0.2.1's decode flag were red herrings (both kept — harmless, and they cover genuine overlay/decoder failure modes). The real fix is v0.3.0's **universal proxy preview** (see v2 above): the bundled ffmpeg decodes anything. Flag-editing note kept for posterity: the config field is `additionalBrowserArgs`, and it *replaces* wry's defaults — always keep `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required`.

## Settled (were open questions)

- Overwrite behavior: kept the script's `-y` (overwrite) for v1 — the README's contract is "reproduce the script's output exactly". Revisit (skip/ask) if it bites.
- ffmpeg build pin: BtbN FFmpeg-Builds, dated autobuild tag, win64 GPL build — pinned by tag + SHA-256 in `scripts/fetch-binaries.ps1`.
