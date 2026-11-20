/* One copy of NitroAI, and a sign of life on the first click.
 *
 * Bug report (Windows, 0.2.2): "I pressed it and waited and it didn't open. I
 * pressed three more times, and after another minute or two all the times I
 * pressed opened at once." A slow first start showed nothing, so every extra
 * click started one more copy.
 *
 *   1. takeSingleInstance(): the second copy quits at once and the first one
 *      brings its window to the front.
 *   2. openSplash(): a small "Starting NitroAI…" window, drawn before the
 *      local server and the sign-in check, closed when the real window is up.
 */
import { app, BrowserWindow } from "electron";

/** The CI update proof and the self-test start short-lived copies on purpose. */
export function isTestRun(env = process.env) {
  return Boolean(env.PUBLIK_UPDATER_TEST || env.PUBLIK_SELF_TEST);
}

/** Restores, shows and focuses the first window that still exists. Returns it, or null. */
export function focusFirst(windows) {
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }
  return null;
}

/**
 * True when this copy may run. False: another copy holds the lock and this
 * one has been told to quit. `getWindows` lists the windows to bring forward,
 * best first, when a later copy is started.
 */
export function takeSingleInstance(getWindows) {
  if (isTestRun()) return true;
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    focusFirst(getWindows());
  });
  return true;
}

const SPLASH = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>NitroAI</title><style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif;
    color: #2b2623; background: #faf7f5; -webkit-user-select: none; cursor: default; }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; opacity: .7; }
  .bar { width: 160px; height: 4px; border-radius: 2px; background: rgba(0,0,0,.1); overflow: hidden; }
  .bar::after { content: ""; display: block; width: 40%; height: 100%; border-radius: 2px; background: #e8590c; animation: go 1.1s ease-in-out infinite alternate; }
  @keyframes go { from { transform: translateX(0); } to { transform: translateX(150%); } }
  @media (prefers-color-scheme: dark) { body { color: #ececec; background: #1e1e1e; } .bar { background: rgba(255,255,255,.14); } }
  @media (prefers-reduced-motion: reduce) { .bar::after { animation: none; width: 100%; } }
</style></head><body><h1>NitroAI</h1><div class="bar"></div><p>Starting. The first start can take a minute.</p></body></html>`;

/** Shows the splash now. Returns { window(), close() }. Safe to close twice. */
export function openSplash() {
  let win = new BrowserWindow({
    width: 360, height: 220, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    frame: false, show: true, title: "NitroAI", backgroundColor: "#faf7f5",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH)}`).catch(() => {});
  win.on("closed", () => { win = null; });
  return {
    window: () => win,
    close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
