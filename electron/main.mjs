/* NitroAI desktop shell.
 *
 * The app is a local web app. This shell:
 *   1. starts the local server (serves the built UI + native helpers) on launch
 *   2. opens a window pointed at it
 *   3. keeps the server alive — if it ever stops answering, it's restarted so
 *      the window is never left showing a dead page
 *   4. shuts the server (and every program it started) down on quit, with a
 *      time limit: quit never waits for ever (lifecycle.mjs)
 *   5. writes what went wrong to a local crash log (crashLog.mjs)
 *
 * Everything the browser can't do — yt-dlp extraction, Ollama provisioning —
 * lives behind that local server (see ../server/). Non-technical users install
 * nothing; developers can run the exact same server with `npm run serve`.
 */

import { app, BrowserWindow, dialog, shell } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killAll as killChildren } from "../server/children.mjs";
import { STABLE_PORTS, startServer, stopServer } from "../server/httpServer.mjs";
import {
  ensureServingIfProvisioned,
  shutdown as shutdownOllama,
} from "../server/ollama.mjs";
// The publik module: Sign in with publik at start-up, the plan choice, usage
// counts and this computer's publik key. The key stays in this process and
// the local server; the renderer talks through /api/publik/.
import { ensureSignedIn, hasAppToken } from "../server/publik.mjs";
import { electronGateUI } from "./publik-gate.mjs";
import { CRASH_LOG_NAME, createCrashLog, installCrashHandlers } from "./crashLog.mjs";
import { armQuit, guardWindow, shouldQuitWhenAllClosed } from "./lifecycle.mjs";
import { isTestRun, openSplash, takeSingleInstance } from "./startup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Signed self-updates (publik-updater.cjs, docs/updates.md). The updater files
// are CommonJS and are shared unchanged by every publik Electron app.
const require = createRequire(import.meta.url);
const { startUpdates } = require("./publik-updater.cjs");

// First of all: from here on an error nobody handled is one line in
// <userData>/crash.log, not Electron's error box, and the app keeps running.
const crashLog = createCrashLog(path.join(app.getPath("userData"), CRASH_LOG_NAME), {
  info: { version: app.getVersion(), platform: process.platform, arch: process.arch },
});
installCrashHandlers({ app, log: crashLog });
// Quit: stopAll() at 'will-quit', and app.exit() three seconds after the quit
// was requested if the process is still here. Before the one-copy check
// below, which quits a second copy.
const quit = armQuit(app, { cleanup: () => stopAll(), log: crashLog });

let mainWindow = null;
let serverInfo = null; // { server, port, url }
let healthTimer = null;
// True once the app's own window has been created ('activate' on macOS opens
// a new one only then).
let appWindowCreated = false;
// True during the start: the splash and the publik gate take turns, and their
// planned closes must not count as "all windows closed". Closing the gate
// itself quits the app (publik-gate.mjs).
let starting = true;
// The "Starting NitroAI…" window (startup.mjs), from launch until the gate or
// the app's own window is on screen.
let splash = null;
// One copy only: a second start brings this copy's window forward and quits.
const firstCopy = takeSingleInstance(() => [mainWindow, ...BrowserWindow.getAllWindows(), splash?.window()]);

function binDir() {
  return path.join(app.getPath("userData"), "bin");
}

async function ensureServer() {
  if (serverInfo) {
    try {
      // The app-only header: the server's guard refuses /api/* without it.
      const res = await fetch(`${serverInfo.url}/api/health`, {
        headers: { "x-nitroai-app": "1" },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return serverInfo;
    } catch {
      /* server died — fall through and restart */
    }
    // Also its open requests: they would keep the old server alive.
    void stopServer(serverInfo.server);
    serverInfo = null;
  }
  serverInfo = await startServer({
    distDir: path.join(__dirname, "..", "dist"),
    binDir: binDir(),
    // The trimmed lecture videos ("Trim the solve-time gaps", server/lecture.mjs).
    mediaDir: path.join(app.getPath("userData"), "lectures"),
    host: "127.0.0.1",
    // A stable port keeps the renderer's origin (and so its localStorage /
    // IndexedDB) the same across launches — see STABLE_PORTS in httpServer.mjs.
    ports: STABLE_PORTS,
    // The module reads the app token and the key itself (server/publik.mjs);
    // the renderer never sees either — it talks through /api/publik/.
    publik: { available: hasAppToken(), appVersion: app.getVersion() },
    onError: (err) => crashLog.write("server-error", err),
  });
  return serverInfo;
}

/* Poll health; if the server is gone, restart it and reload the window so the
   user never sees a blank/broken page. */
function startHealthWatch() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!mainWindow || quit.quitting()) return;
    try {
      const before = serverInfo?.url;
      const info = await ensureServer();
      // The quit may have started during the check: no new server then.
      if (quit.quitting()) return stopAll();
      if (info.url !== before && mainWindow) await mainWindow.loadURL(info.url);
    } catch (err) {
      crashLog.write("health-watch-failed", err);
    }
  }, 5000);
}

async function createWindow() {
  const info = await ensureServer();
  appWindowCreated = true;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#faf7f5",
    title: "NitroAI",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank / external links in the system browser, not a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(info.url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  const win = mainWindow;
  // A page that does not answer still closes; a page that ended loads again.
  guardWindow(win, { log: crashLog });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // A failed first load is not the end: the health watch below loads the page
  // again when the server answers on another address.
  await win.loadURL(info.url).catch((err) => crashLog.write("load-failed", err));
  splash?.close();
  startHealthWatch();

  // If this machine was set up for local AI in a past session, restart Ollama
  // now (we kill it on quit). No-op for cloud users. Non-blocking.
  void ensureServingIfProvisioned(binDir(), info.url);
}

app.whenReady().then(async () => {
  if (!firstCopy) return;
  let testHook = false; // the CI update proof runs with no window and exits by itself
  try {
    // Updates: checks publik's signed update feed at launch and every 24 h, and
    // adds "Check for Updates…" to the menu (macOS: the NitroAI menu; Windows:
    // Help). A test build started with PUBLIK_UPDATER_TEST runs the CI update
    // proof and exits instead: nothing below starts.
    testHook = startUpdates({ slug: "nitroai", appName: "NitroAI" }).testHook;
    if (testHook) return;

    // Every publik app opens with Sign in with publik. The gate window shows
    // until this computer is signed in (no pay screen: the choice is "publik"
    // until the person changes it in Settings), and starts the usage counts (app_opened now, active_session every 30 minutes).
    // PUBLIK_SELF_TEST=1 makes it print the self-test line and exit instead.
    // Something on screen at once: the sign-in check and the local server can
    // take a while on a first start, and a click with no answer gets clicked again.
    if (!isTestRun()) splash = openSplash();
    const gate = electronGateUI({ appName: "NitroAI" });
    // The gate draws a screen only when this computer must sign in;
    // its window then takes the splash's place.
    const ui = { ...gate, show: (screen, signal) => { splash?.close(); return gate.show(screen, signal); } };
    await ensureSignedIn(ui);
    if (!isTestRun() && !splash?.window()) splash = openSplash();
    gate.close();
    await createWindow();
  } catch (err) {
    // A start that failed left a process with no window (and, with the
    // one-copy lock, an app that did not open again until that process was
    // ended in Task Manager). Say it, write it down, quit.
    crashLog.write("startup-failed", err);
    splash?.close();
    if (!isTestRun() && !quit.quitting()) {
      dialog.showErrorBox("NitroAI could not start", `${err instanceof Error ? err.message : String(err)}\n\nThe details are in ${crashLog.file}`);
    }
    app.quit();
  } finally {
    splash?.close();
    starting = false;
    // The window was closed while the page loaded: no "all windows closed"
    // comes after this point, so decide now.
    if (!testHook && BrowserWindow.getAllWindows().length === 0 && shouldQuitWhenAllClosed({ starting })) app.quit();
  }
});

app.on("activate", () => {
  if (appWindowCreated && !starting && BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((err) => crashLog.write("window-failed", err));
  }
});

// Windows and Linux: the last window closed = quit. macOS: the app stays in
// the Dock until Cmd+Q.
app.on("window-all-closed", () => {
  if (shouldQuitWhenAllClosed({ starting })) app.quit();
});

/* Stops everything that could outlive the window: the health watch, the
   programs the server started (yt-dlp, ffmpeg), Ollama, and the local server
   with its open requests. */
function stopAll() {
  clearInterval(healthTimer);
  killChildren();
  shutdownOllama();
  if (serverInfo) void stopServer(serverInfo.server);
  serverInfo = null;
}
