// Lay the ffmpeg.wasm runtime into the web build. Kept out of public/ so the
// desktop bundle (tauri frontendDist) never carries ~50 MB of wasm cores.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/ffmpeg", { recursive: true });
// Single-thread + multithread cores; the app picks at runtime by
// crossOriginIsolated (coi-serviceworker usually makes mt possible).
cpSync("node_modules/@ffmpeg/core/dist/esm", "dist/ffmpeg/core", { recursive: true });
cpSync("node_modules/@ffmpeg/core-mt/dist/esm", "dist/ffmpeg/core-mt", { recursive: true });
// The FFmpeg class worker (imports its siblings relatively — copy the dir).
cpSync("node_modules/@ffmpeg/ffmpeg/dist/esm", "dist/ffmpeg/class", { recursive: true });
cpSync("node_modules/coi-serviceworker/coi-serviceworker.min.js", "dist/coi-serviceworker.min.js");
console.log("copied ffmpeg.wasm runtime into dist/");
