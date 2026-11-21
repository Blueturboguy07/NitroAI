/* The programs the local server starts (yt-dlp, ffmpeg, `ollama serve`), so
 * the app can end them when it quits.
 *
 * Bug report (Windows): "It refused to close. I had to go into Task Manager."
 * A request that is cut ends its program through an AbortSignal, but nothing
 * ended the programs when the app itself quit. On Windows child.kill() ends
 * one process only: yt-dlp.exe is two processes (a PyInstaller start program
 * and the real one) and it starts ffmpeg, and `ollama serve` starts a model
 * runner. Those stayed in Task Manager after the window closed.
 */
import { spawn } from "node:child_process";

const live = new Set();

/** Remembers a child until it ends. Returns the child. Anything else passes through. */
export function track(child) {
  if (!child || typeof child.once !== "function") return child;
  live.add(child);
  const drop = () => live.delete(child);
  child.once("exit", drop);
  child.once("error", drop);
  return child;
}

/**
 * Ends a child and the processes it started. Windows: `taskkill /T /F` (the
 * whole tree; a plain kill first would hide the tree from taskkill). Other
 * systems: SIGTERM, which yt-dlp's start program passes on. Never throws.
 */
export function killTree(child, { platform = process.platform, run = spawn } = {}) {
  if (!child) return;
  const plain = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  if (platform !== "win32" || !child.pid) return plain();
  try {
    const killer = run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on?.("error", plain); // no taskkill on this computer
    killer.unref?.();
  } catch {
    plain();
  }
}

/** Ends every child that still runs. Returns how many. */
export function killAll(opts) {
  const children = [...live];
  live.clear();
  for (const child of children) killTree(child, opts);
  return children.length;
}

/** How many children run now (tests). */
export function liveCount() {
  return live.size;
}
