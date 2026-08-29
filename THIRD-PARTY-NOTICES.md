# Third-Party Notices

Kecilin's own source code is distributed under the Apache License 2.0 (see
[LICENSE](LICENSE)).

Release builds of Kecilin bundle the following third-party software, which is
**not** part of this repository's source (it is downloaded at build time by
`scripts/fetch-binaries.ps1` and packaged into the installer). It is
distributed under its own license.

---

## FFmpeg

- **Project:** FFmpeg — <https://ffmpeg.org>
- **Copyright:** © the FFmpeg developers
- **License:** GNU General Public License v3 — the bundled build enables GPL
  components, notably **libx264** (© x264 project, GPL). License text:
  <https://www.gnu.org/licenses/gpl-3.0.html>
- **Bundled file:** `ffmpeg.exe` (a Windows GPL build from the BtbN
  FFmpeg-Builds project, pinned by tag in `scripts/fetch-binaries.ps1`)
- **Source code:** <https://ffmpeg.org/download.html> (FFmpeg) and
  <https://github.com/BtbN/FFmpeg-Builds> (build scripts; each release tag
  links the exact source revisions it was built from)

Kecilin invokes `ffmpeg.exe` as a separate process (a Tauri sidecar); it is
not linked into the application. Distribution of the bundled binary is under
the GPLv3, with the notices and source links above.

## ffmpeg.wasm (web version)

- **Project:** ffmpeg.wasm — <https://github.com/ffmpegwasm/ffmpeg.wasm>
- **License:** the JS wrapper is MIT; the bundled cores (`@ffmpeg/core`,
  `@ffmpeg/core-mt`) are FFmpeg compiled to WebAssembly with GPL components
  (libx264) and are distributed under the **GPLv3** with the same FFmpeg
  notices as above.
- **Served files:** the web deployment at GitHub Pages ships these cores under
  `/ffmpeg/`; they execute entirely in the visitor's browser.

## coi-serviceworker (web version)

- **Project:** <https://github.com/gzuidhof/coi-serviceworker> — MIT license.
