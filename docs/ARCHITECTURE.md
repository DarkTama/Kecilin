# Architecture — Kecilin

_Last updated: 2026-08-24 (v1 implemented — Rust core in [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs)). Source of truth for the encode: [`compress.bat`](../compress.bat)._

## High-level shape

```
┌──────────────────────────────────────────────────────────┐
│  Frontend  (React 19 + Tailwind v4, in the Tauri webview) │
│   • Folder picker / presets / per-file trim / queue+bars  │
│   • Zustand store mirrors backend state                   │
│   • Calls Rust via `invoke`; listens for progress events  │
├──────────────────────────────────────────────────────────┤
│  Rust core  (Tauri 2 commands + state)                    │
│   • Scans the folder for video files                      │
│   • Spawns one ffmpeg sidecar per file, sequentially      │
│   • Parses ffmpeg output → progress events                │
│   • Tracks the running child for cancel                   │
├──────────────────────────────────────────────────────────┤
│  Bundled sidecar binary                                   │
│   • ffmpeg(.exe)                                          │
└──────────────────────────────────────────────────────────┘
```

**Key principle** (inherited from AnyLeap): the Rust core is *thin* — file discovery, process orchestration, output parsing. All video work lives in ffmpeg.

## Command surface

| Command | Purpose |
|---------|---------|
| `scan_directory(path)` | List `.mp4` `.mov` `.mkv` `.avi` `.webm` at the top level → `[{ path, name, size, duration }]`. Duration parsed from `ffmpeg -hide_banner -i {file}` stderr (header only, ~ms per file — no ffprobe, no extra sidecar). |
| `start_batch(items, preset)` | `items: [{ path, trim?: { start, end } }]`. Create `whatsapp_{preset}` inside the source folder; convert sequentially; emit events. |
| `cancel_batch()` | Kill the current ffmpeg child; skip the remaining queue. |

Events (backend → frontend, Tauri events — never blocking command returns):

| Event | Payload |
|-------|---------|
| `file:start` | `{ path, index }` |
| `file:progress` | `{ index, percent }` |
| `file:done` | `{ index, ok }` — a failure marks the file and moves on (script behavior) |
| `batch:done` | `{ converted, failed }` |

## The encode (verbatim from compress.bat)

### Presets

| Preset | HEIGHT | CRF | MAX (maxrate) | BUF (bufsize) | LEVEL | Label in UI |
|--------|--------|-----|---------------|---------------|-------|-------------|
| 360p | 360 | 24 | 1200k | 2400k | 3.1 | small, good for long clips |
| 480p | 480 | 22 | 2200k | 4400k | 3.1 | balanced small |
| 720p | 720 | 20 | 4200k | 8400k | 4.1 | better quality, gameplay-friendly |

### Per-file invocation

Passed to the sidecar as an argument **array** (`std::process::Command` / Tauri shell API — no shell, no quoting bugs):

```
ffmpeg -y -i {input}
  -map 0:v:0 -map 0:a?
  -vf scale=-2:{HEIGHT}:flags=lanczos
  -c:v libx264 -preset slow -profile:v high -level {LEVEL} -pix_fmt yuv420p
  -crf {CRF} -maxrate {MAX} -bufsize {BUF}
  -g 120 -keyint_min 60 -sc_threshold 40 -bf 3 -refs 4 -rc-lookahead 40
  -x264-params aq-mode=3:aq-strength=0.8
  -c:a aac -q:a 2 -ar 48000 -ac 2
  -movflags +faststart
  {OUT}\{stem}_whatsapp_{preset}.mp4
```

Why these flags matter (don't "clean them up"):

- `scale=-2:{HEIGHT}` — preserves aspect ratio; `-2` keeps the width even, which `yuv420p` requires.
- `-map 0:a?` — the `?` means "audio if present"; silent videos must not fail.
- `-profile:v high -pix_fmt yuv420p` + AAC 48 kHz stereo — the compatibility floor for WhatsApp playback on old devices.
- `-movflags +faststart` — moov atom up front so WhatsApp can preview/scrub immediately.
- `-y` — the script overwrote existing output; GUI policy is an open question (skip vs. ask).

## Trimming

Because every file is re-encoded anyway, trimming is two extra arguments — **frame-accurate for free** (no keyframe snapping, unlike stream-copy trimmers):

```
ffmpeg -y -ss {start} -i {input} -t {end - start} ... (rest of the encode unchanged)
```

`-ss` before `-i` = fast input seek; with re-encode it decodes from the prior keyframe and discards, so the cut lands exactly. `-t {duration}` instead of `-to` avoids the classic ambiguity of `-to` after an input-side seek. No trim set → both args omitted.

**Trim UI**: dual-handle range slider over an HTML5 `<video>` preview, loaded via Tauri's asset protocol (`convertFileSrc`). Caveat: WebView2 decodes `.mp4`/`.webm` natively but usually not `.mkv`/`.avi`/`.mov` — when the preview can't play, fall back to the slider alone (bounds come from the scanned duration) plus typed start/end fields. No thumbnail strips or waveforms in v1.

## Progress reporting

ffmpeg alone is enough — **no ffprobe sidecar**:

1. **Total duration**: parse `Duration: HH:MM:SS.cc` from ffmpeg's own stderr header at process start. If the file is trimmed, the denominator is `end - start` instead.
2. **Position**: run with `-progress pipe:1 -nostats`; parse `out_time_ms=` key-value lines from stdout.
3. `percent = out_time / duration`; emit `file:progress`, throttled to ~4 events/sec.

Batch progress = simple file count (`done / total`) in v1; duration-weighted is a v2 nicety.

## Bundling ffmpeg (same playbook as AnyLeap)

- Ship as a Tauri **sidecar** (`externalBin` in `tauri.conf.json`), platform-suffixed: `ffmpeg-x86_64-pc-windows-msvc.exe`.
- Binary stays **out of git** (~100 MB): `src-tauri/binaries/` gitignored; `scripts/fetch-binaries.ps1` downloads a **pinned** BtbN win64-gpl build (dated autobuild tag + SHA-256) at setup/build time, wired to `postinstall` like AnyLeap.
- **Licensing**: ffmpeg builds with libx264 are **GPL**. Bundling one means the app's distribution must be GPL-compatible and ship third-party notices — copy AnyLeap's `THIRD-PARTY-NOTICES.md` approach.
- Verify the sidecar on launch (`ffmpeg -version`) and surface a clear error if missing/broken.

## Concurrency

- **v1: sequential**, matching the script. `libx264 -preset slow` already saturates the CPU on one file; parallelism would mostly thrash.
- **v2**: Tokio worker pool up to core count — pays off for many short clips, not for a few long ones.

## Cross-platform notes

Windows-first (author's OS). Tauri keeps macOS/Linux viable; the only platform-specific parts are the sidecar binary name and the fetch script.

## Settled decisions

- Overwrite when the output file already exists (`-y`), matching the script's contract. Revisit if it bites.
- ffmpeg pin: BtbN FFmpeg-Builds win64-gpl, dated autobuild tag + SHA-256 in `scripts/fetch-binaries.ps1`.
