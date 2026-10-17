import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import hot from "react-hot-toast";

let running = false;

/**
 * Looks for a newer release on GitHub (latest.json). When there is one it downloads and installs it
 * in the background and shows a toast, so updates need no clicks.
 */
export async function autoUpdate() {
  if (running) return;
  running = true;
  try {
    const update = await check();
    if (!update) return;
    const id = hot.loading(`Updating ChatVault to ${update.version}…`);
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        if (total) hot.loading(`Updating ChatVault to ${update.version}… ${Math.round((got / total) * 100)}%`, { id });
      }
      if (ev.event === "Finished") hot.loading(`Installing ChatVault ${update.version}. It will restart by itself.`, { id });
    });
    hot.success(
      (t) => (
        <span className="flex items-center gap-3">
          <span>ChatVault {update.version} is ready.</span>
          <button
            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
            onClick={() => {
              hot.dismiss(t.id);
              void relaunch();
            }}
          >
            Restart now
          </button>
        </span>
      ),
      { id, duration: Infinity },
    );
  } catch (e) {
    // Offline, or no release has been published yet. Try again later.
    console.warn("Update check failed", e);
  } finally {
    running = false;
  }
}

export function startAutoUpdate() {
  const first = window.setTimeout(autoUpdate, 4000);
  const every = window.setInterval(autoUpdate, 4 * 60 * 60 * 1000);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(every);
  };
}
