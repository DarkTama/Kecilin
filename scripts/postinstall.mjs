// Fetch the ffmpeg sidecar on Windows dev/CI machines; skip everywhere the
// desktop binary isn't needed (Pages deploy sets KECILIN_SKIP_FFMPEG=1, and
// non-Windows runners have no use for the .exe).
import { spawnSync } from "node:child_process";

if (process.env.KECILIN_SKIP_FFMPEG === "1" || process.platform !== "win32") {
  console.log("postinstall: skipping ffmpeg sidecar fetch");
  process.exit(0);
}

const r = spawnSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/fetch-binaries.ps1"],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
