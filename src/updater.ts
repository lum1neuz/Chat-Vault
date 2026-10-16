import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

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
    const id = toast.loading(`Updating ChatVault to ${update.version}`, { description: "Downloading in the background." });
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        if (total) toast.loading(`Updating ChatVault to ${update.version}`, { id, description: `${Math.round((got / total) * 100)}% downloaded` });
      }
      if (ev.event === "Finished") {
        toast.loading(`Installing ChatVault ${update.version}`, { id, description: "ChatVault will restart by itself." });
      }
    });
    toast.success(`ChatVault ${update.version} is ready`, {
      id,
      description: "Restart to finish updating.",
      duration: Infinity,
      action: { label: "Restart now", onClick: () => void relaunch() },
    });
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
