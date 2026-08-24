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

### Next up — QoL round 2 (planned, from usage feedback)

- **Remove from queue** — an × on each row to unselect a video, plus a "Clear queue" action; today the only way out is rescanning.
- **Version info in the app** — show the current version in a footer (`getVersion()`), clicking it opens the releases page; pairs with the existing launch update check.
- **Result stats** — done rows show output size and savings ("205.6 MB → 24.1 MB, −88%"); the batch summary shows total space saved. (Data is free: stat the output after each file.)
- **Reveal converted file** — a button on a done row that opens/reveals its own output in Explorer (not just the folder).
- **Batch-finished notification** — a Windows toast when the batch ends while the window is unfocused; conversions run for minutes and people tab away.
- **Remember preferences** — persist preset, custom output folder, and window size across runs (small settings file, same plugin-store approach as AnyLeap).

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
