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

### v2+

- Parallel conversion (Tokio pool up to core count — mostly pays off for many short clips).
- Drag-and-drop individual files onto the window.
- Custom preset editor / advanced flags.
- Optional GPU encode (NVENC) for speed at some quality cost.
- Recursive folder scan; smarter overwrite policy.
- macOS / Linux builds.

### Non-goals

- **Not** a video editor beyond trim — no crop, filters, joining, or multi-segment cuts.
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

## Settled (were open questions)

- Overwrite behavior: kept the script's `-y` (overwrite) for v1 — the README's contract is "reproduce the script's output exactly". Revisit (skip/ask) if it bites.
- ffmpeg build pin: BtbN FFmpeg-Builds, dated autobuild tag, win64 GPL build — pinned by tag + SHA-256 in `scripts/fetch-binaries.ps1`.
