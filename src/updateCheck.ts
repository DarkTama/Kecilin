import { getVersion } from "@tauri-apps/api/app";
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { translate } from "./i18n";
import { useStore } from "./store";

export const RELEASES_PAGE = "https://github.com/DarkTama/Kecilin/releases";

/**
 * Launch-time update check via the Tauri updater: signed installer, in-app
 * download + install, then relaunch. Never throws; silent on any failure
 * (offline, no latest.json for this platform, …).
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    const lang = useStore.getState().lang;
    const current = await getVersion();
    const yes = await ask(translate(lang, "updateBody", { v: update.version, cur: current }), {
      title: translate(lang, "updateTitle"),
      kind: "info",
      okLabel: translate(lang, "updateOk"),
      cancelLabel: translate(lang, "updateLater"),
    });
    if (!yes) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch {
    // offline / unsigned platform / user closed the installer — silent by design
  }
}
