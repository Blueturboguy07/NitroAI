/* NitroAI desktop shell.
 *
 * The app is a local web app. This shell:
 *   1. starts the local server (serves the built UI + native helpers) on launch
 *   2. opens a window pointed at it
 *   3. keeps the server alive — if it ever stops answering, it's restarted so
 *      the window is never left showing a dead page
 *   4. shuts the server (and any Ollama it started) down on quit
 *
 * Everything the browser can't do — yt-dlp extraction, Ollama provisioning —
 * lives behind that local server (see ../server/). Non-technical users install
 * nothing; developers can run the exact same server with `npm run serve`.
 */

import { app, BrowserWindow, shell } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STABLE_PORTS, startServer } from "../server/httpServer.mjs";
import {
  ensureServingIfProvisioned,
  shutdown as shutdownOllama,
} from "../server/ollama.mjs";
// The publik module: Sign in with publik at start-up, the plan choice, usage
// counts and this computer's publik key. The key stays in this process and
// the local server; the renderer talks through /api/publik/.
import { ensureSignedIn, hasAppToken } from "../server/publik.mjs";
import { electronGateUI } from "./publik-gate.mjs";
import { isTestRun, openSplash, takeSingleInstance } from "./startup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Signed self-updates (publik-updater.cjs, docs/updates.md). The updater files
// are CommonJS and are shared unchanged by every publik Electron app.
const require = createRequire(import.meta.url);
const { startUpdates } = require("./publik-updater.cjs");

let mainWindow = null;
let serverInfo = null; // { server, port, url }
let healthTimer = null;
// True once the app's own window has been created. Before that, the only
// window is the publik gate: closing it quits the app (publik-gate.mjs), and
// its planned close after the sign-in must not count as "all windows closed".
let appWindowCreated = false;
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
    try {
      serverInfo.server.close();
    } catch {
      /* already closed */
    }
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
  });
  return serverInfo;
}

/* Poll health; if the server is gone, restart it and reload the window so the
   user never sees a blank/broken page. */
function startHealthWatch() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!mainWindow) return;
    const before = serverInfo?.url;
    const info = await ensureServer();
    if (info.url !== before) {
      mainWindow.loadURL(info.url);
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(info.url);
  splash?.close();
  startHealthWatch();

  // If this machine was set up for local AI in a past session, restart Ollama
  // now (we kill it on quit). No-op for cloud users. Non-blocking.
  void ensureServingIfProvisioned(binDir(), info.url);
}

app.whenReady().then(async () => {
  if (!firstCopy) return;
  // Updates: checks publik's signed update feed at launch and every 24 h, and
  // adds "Check for Updates…" to the menu (macOS: the NitroAI menu; Windows:
  // Help). A test build started with PUBLIK_UPDATER_TEST runs the CI update
  // proof and exits instead: nothing below starts.
  if (startUpdates({ slug: "nitroai", appName: "NitroAI" }).testHook) return;

  // Every publik app opens with Sign in with publik. The gate window shows
  // until this computer is signed in, asks once how the app pays for AI, and
  // starts the usage counts (app_opened now, active_session every 30 minutes).
  // PUBLIK_SELF_TEST=1 makes it print the self-test line and exit instead.
  // Something on screen at once: the sign-in check and the local server can
  // take a while on a first start, and a click with no answer gets clicked again.
  if (!isTestRun()) splash = openSplash();
  const gate = electronGateUI({ appName: "NitroAI" });
  // The gate draws a screen only when this computer must sign in or choose;
  // its window then takes the splash's place.
  const ui = { ...gate, show: (screen, signal) => { splash?.close(); return gate.show(screen, signal); } };
  await ensureSignedIn(ui);
  if (!isTestRun() && !splash?.window()) splash = openSplash();
  gate.close();
  try {
    return await createWindow();
  } finally {
    splash?.close();
  }
});

app.on("activate", () => {
  if (appWindowCreated && BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (appWindowCreated && process.platform !== "darwin") app.quit();
});

/* Tear the local server and any Ollama we spawned down when the app exits. */
app.on("will-quit", () => {
  clearInterval(healthTimer);
  shutdownOllama();
  if (serverInfo) {
    try {
      serverInfo.server.close();
    } catch {
      /* already closed */
    }
    serverInfo = null;
  }
});
