import type { Engine } from "./types";

/** True in the GitHub Pages build (`vite build --mode web`). */
export const IS_WEB = import.meta.env.MODE === "web";

export const engine: Engine = IS_WEB
  ? (await import("./wasm")).wasmEngine
  : (await import("./tauri")).tauriEngine;
