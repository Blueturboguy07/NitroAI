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
import { appToken } from "../server/publik.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Inside app.asar this carries electron-builder's extraMetadata — including
// `publik.appToken`, the build-time token that lets a fresh install mint its
// own publik API key. Null in forks and local builds (see electron-builder.cjs).
const pkg = require("../package.json");

let mainWindow = null;
let serverInfo = null; // { server, port, url }
let healthTimer = null;
let serverStarting = null; // in-flight ensureServer() — one restart at a time
/* The port this run settled on. Restarts reuse it so the renderer keeps the
   same origin — a different port is a different origin, i.e. an empty
   IndexedDB library and lost prefs. */
let boundPort = null;

function binDir() {
  return path.join(app.getPath("userData"), "bin");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Close a server and wait until its port is actually released (drop
   keep-alive/streaming sockets so close() can finish), bounded so a wedged
   socket can't stall the restart forever. */
function closeServer(server) {
  return new Promise((resolve) => {
    const done = () => resolve();
    const timer = setTimeout(done, 3000);
    try {
      server.close(() => {
        clearTimeout(timer);
        done();
      });
      server.closeAllConnections?.();
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

function serverOptions(ports) {
  return {
    distDir: path.join(__dirname, "..", "dist"),
    binDir: binDir(),
    host: "127.0.0.1",
    ports,
    // The token stays in this process and the local server; the renderer
    // never sees it (nor the minted key — it talks through /api/publik/).
    publik: { token: appToken({ packageJson: pkg }), appVersion: app.getVersion() },
  };
}

async function startOnStablePort() {
  if (boundPort) {
    // Restart: insist on the same port for a few seconds (the old socket may
    // still be releasing it) before giving up on origin stability.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await startServer(serverOptions([boundPort]));
      } catch (err) {
        if (err?.code !== "EADDRINUSE") throw err;
        await sleep(500);
      }
    }
    console.warn(`[nitroai] port ${boundPort} is still busy; falling back to another port (new origin).`);
  }
  // First start: a stable port keeps the renderer's origin (and so its
  // localStorage / IndexedDB) the same across launches — see STABLE_PORTS.
  return startServer(serverOptions(STABLE_PORTS));
}

async function ensureServerOnce() {
  if (serverInfo) {
    try {
      const res = await fetch(`${serverInfo.url}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return serverInfo;
    } catch {
      /* server died — fall through and restart */
    }
    const dead = serverInfo.server;
    serverInfo = null;
    await closeServer(dead);
  }
  serverInfo = await startOnStablePort();
  boundPort ??= serverInfo.port;
  return serverInfo;
}

function ensureServer() {
  serverStarting ??= ensureServerOnce().finally(() => {
    serverStarting = null;
  });
  return serverStarting;
}

/* Poll health; if the server is gone, restart it and reload the window so the
   user never sees a blank/broken page. */
function startHealthWatch() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!mainWindow) return;
    const before = serverInfo?.url;
    let info;
    try {
      info = await ensureServer();
    } catch (err) {
      console.error("[nitroai] local server restart failed:", err);
      return; // try again on the next tick
    }
    if (mainWindow && info.url !== before) {
      mainWindow.loadURL(info.url);
    }
  }, 5000);
}

async function createWindow() {
  const info = await ensureServer();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#faf7f5",
    title: "NitroAI",
    ...(app.isPackaged ? {} : { icon: DEV_ICON }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank / external links in the system browser, not a new
  // window. Compare whole origins (a prefix check would treat
  // http://127.0.0.1:417630 as ours) against the CURRENT server, which may
  // have been restarted since this window was created.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return { action: "deny" };
    }
    const ours = serverInfo ? new URL(serverInfo.url).origin : new URL(info.url).origin;
    if (target.origin === ours) return { action: "allow" };
    if (target.protocol === "http:" || target.protocol === "https:") shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(info.url);
  startHealthWatch();

  // If this machine was set up for local AI in a past session, restart Ollama
  // now (we kill it on quit). No-op for cloud users. Non-blocking.
  void ensureServingIfProvisioned(binDir(), info.url);
}

/* `npm run app` runs inside Electron's own developer app, which shows the
   Electron icon. Show NitroAI's icon instead. (A packaged build carries the
   icon in its bundle, and build-resources/ isn't shipped, so this is
   dev-only.) */
const DEV_ICON = path.join(__dirname, "..", "build-resources", "icon.png");

/* One instance only. A second instance would start its own server on the
   next free port — a different origin, so the user would see an empty
   library (IndexedDB/localStorage are per-origin). Instead it hands off to
   the running instance, which brings its window forward. */
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) {
      void createWindow();
    }
  });

  app.whenReady().then(() => {
    if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(DEV_ICON);
    return createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
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
