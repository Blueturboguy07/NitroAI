/* Quit always ends, and a window always closes.
 *
 * Bug report (Windows): "It refused to close. I had to go into Task Manager
 * and force it." Three rules, each with a time limit, so no path waits for ever:
 *
 *   1. guardWindow(): a window whose page does not answer (a long task in the
 *      page) does not close on the close button; Electron only sends
 *      'unresponsive'. Three seconds after a close request the window is
 *      destroyed. A page whose process ended is loaded again (at most 3 times
 *      in a minute) in place of a blank window.
 *   2. shouldQuitWhenAllClosed(): on Windows and Linux the app quits when its
 *      last window closes. The only exception is the start, when the splash
 *      and the sign-in window take turns.
 *   3. armQuit(): when quit is requested, the clean-up runs and a deadline
 *      starts. If the process is still here after 3 seconds, app.exit() ends it.
 *
 * The app has no "are you sure?" on close (no beforeunload, no 'close'
 * handler that says no). If one is added, rules 1 and 3 must learn about it.
 */

export const CLOSE_DEADLINE_MS = 3000;
export const QUIT_DEADLINE_MS = 3000;
export const RELOAD_LIMIT = 3;
export const RELOAD_WINDOW_MS = 60_000;

/** True when "the last window closed" must quit the app. */
export function shouldQuitWhenAllClosed({ starting, platform = process.platform }) {
  return !starting && platform !== "darwin";
}

/**
 * Rule 3. `cleanup` runs once, at 'will-quit' or at the deadline, whichever
 * is first. Returns { quitting() }.
 */
export function armQuit(app, { cleanup = () => {}, ms = QUIT_DEADLINE_MS, log, setTimer = (fn, t) => setTimeout(fn, t) } = {}) {
  let quitting = false;
  let cleaned = false;
  const clean = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      cleanup();
    } catch (err) {
      log?.write("quit-cleanup-failed", err);
    }
  };
  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
    setTimer(() => {
      log?.write("quit-forced", null, { afterMs: ms });
      clean();
      app.exit(0);
    }, ms);
  });
  app.on("will-quit", clean);
  return { quitting: () => quitting };
}

/** Rule 1. `win` is a BrowserWindow. */
export function guardWindow(win, { log, ms = CLOSE_DEADLINE_MS, setTimer = (fn, t) => setTimeout(fn, t), clearTimer = (t) => clearTimeout(t), now = Date.now } = {}) {
  let timer = null;
  win.on("close", () => {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      if (win.isDestroyed()) return;
      log?.write("window-close-forced", null, { afterMs: ms });
      win.destroy();
    }, ms);
  });
  win.on("closed", () => {
    if (timer) clearTimer(timer);
    timer = null;
  });
  win.on("unresponsive", () => log?.write("window-unresponsive"));

  let reloads = [];
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details?.reason === "clean-exit" || win.isDestroyed()) return;
    const t = now();
    reloads = reloads.filter((at) => t - at < RELOAD_WINDOW_MS);
    if (reloads.length >= RELOAD_LIMIT) return; // it ends again and again: stop, the log has each one
    reloads.push(t);
    try {
      win.webContents.reload();
    } catch (err) {
      log?.write("reload-failed", err);
    }
  });
}
