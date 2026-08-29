# Kecilin

**"Shrink it!"** (Indonesian) — a tiny Windows app that batch-compresses videos into WhatsApp-ready copies *before* WhatsApp gets the chance to mangle them. Pick a folder, pick a preset, convert. No command line, ever.

> **Status:** v1 implemented. Grab the installer or portable zip from [Releases](https://github.com/DarkTama/Kecilin/releases).

## Features (v1)

- **Folder in, WhatsApp-ready out** — scans a folder for `.mp4` `.mov` `.mkv` `.avi` `.webm` and converts everything into a `whatsapp_{preset}` subfolder.
- **Three presets, zero knobs:**

  | Preset | CRF | Max bitrate | Good for |
  |--------|-----|-------------|----------|
  | 360p | 24 | 1200k | small, long clips |
  | 480p | 22 | 2200k | balanced small |
  | 720p | 20 | 4200k | better quality, gameplay |

- **Trim with two drag handles — into as many parts as you like** — per file, optional, and frame-accurate (the app re-encodes anyway, so no keyframe snapping). Add multiple ranges to split one video into `_part1`, `_part2`, … files. The preview has play/pause and a live playhead marker.
- **Previews that always work** — every row gets a thumbnail, and if Windows can't decode a format (HEVC without the codec extension, `.mkv`, `.avi`), the bundled ffmpeg quietly builds a small preview proxy instead. Nothing to install.
- **Files or folders, output anywhere** — add individual videos via picker or drag-and-drop alongside folder scans, remove them with a click, and optionally redirect all output to a folder of your choice.
- **From result to WhatsApp in one motion** — done rows show the size saved, reveal in Explorer, copy to clipboard for Ctrl+V, or just drag the thumbnail straight into a chat. A toast fires when a batch finishes in the background.
- **Guided choices** — each preset shows a worst-case size estimate for your queue, audio can be muted or turned down per file, and 30-second "Status mode" stamps fixed-length parts.
- **Multi-track audio, handled** — OBS-style recordings with separate game/mic tracks get a per-file source picker (any track, or merge them all), plus one-toggle loudness normalization.
- **Real progress bars** — per file and per batch; a failed file is marked and the batch keeps going.
- **Self-contained** — ffmpeg ships inside as a Tauri sidecar; nothing to install.

## Install

From [Releases](https://github.com/DarkTama/Kecilin/releases):

- `Kecilin_*_x64-setup.exe` — installer
- `Kecilin-*-portable-win64.zip` — portable (unzip and run `kecilin.exe`)

Builds are unsigned, so Windows SmartScreen may warn on first run ("More info" → "Run anyway"). Requires the WebView2 runtime (preinstalled on Windows 11 / most Windows 10).

## How it works

A thin **Tauri 2** (Rust) shell + **React** UI driving a bundled **ffmpeg** sidecar — the same wrap-don't-reimplement architecture as [AnyLeap](https://github.com/DarkTama/Anyleap). The encode targets WhatsApp's compatibility floor: H.264 High profile, `yuv420p`, AAC 48 kHz stereo, `+faststart` for instant preview.

## The original script

The GUI wraps a proven batch script, which still works standalone if you'd rather skip the app:

1. Install [ffmpeg](https://ffmpeg.org/) and make sure it's on your `PATH`.
2. Run [`compress.bat`](compress.bat), point it at a folder, pick a preset.
3. Converted files land in a `whatsapp_{preset}` folder inside that folder.

The GUI's contract is to reproduce this script's output exactly — same flags, same naming, same folder layout.

## Tech stack

Tauri 2 · React 19 + TypeScript + Vite · Tailwind v4 · Zustand · bundled ffmpeg (GPL build with libx264).

## Develop

```
npm install        # also downloads the pinned ffmpeg sidecar (scripts/fetch-binaries.ps1)
npm run tauri dev  # run the app
npm run tauri build
npm run release    # tag v<version> + push → CI builds and publishes the GitHub Release
```

## Docs

Design notes live in [`docs/`](docs/): [PLAN](docs/PLAN.md) · [ARCHITECTURE](docs/ARCHITECTURE.md).

## License

[Apache-2.0](LICENSE). Release builds bundle a GPL ffmpeg binary (libx264) as a separate sidecar process — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
