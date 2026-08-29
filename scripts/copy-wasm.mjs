// Lay the ffmpeg.wasm runtime into the web build. Kept out of public/ so the
// desktop bundle (tauri frontendDist) never carries ~50 MB of wasm cores.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/ffmpeg", { recursive: true });
// Single-thread core only — core-mt is pinned off (wedges on repeat execs
// with WORKERFS mounts; see src/engine/wasm.ts).
cpSync("node_modules/@ffmpeg/core/dist/esm", "dist/ffmpeg/core", { recursive: true });
// The FFmpeg class worker (imports its siblings relatively — copy the dir).
cpSync("node_modules/@ffmpeg/ffmpeg/dist/esm", "dist/ffmpeg/class", { recursive: true });
console.log("copied ffmpeg.wasm runtime into dist/");
