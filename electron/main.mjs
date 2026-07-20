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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/httpServer.mjs";
import {
  ensureServingIfProvisioned,
  shutdown as shutdownOllama,
} from "../server/ollama.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let serverInfo = null; // { server, port, url }
let healthTimer = null;

function binDir() {
  return path.join(app.getPath("userData"), "bin");
}

async function ensureServer() {
  if (serverInfo) {
    try {
      const res = await fetch(`${serverInfo.url}/api/health`, { signal: AbortSignal.timeout(2000) });
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
    host: "127.0.0.1",
    port: 0, // OS-assigned free port; avoids clashes with anything on 4173 etc.
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
  startHealthWatch();

  // If this machine was set up for local AI in a past session, restart Ollama
  // now (we kill it on quit). No-op for cloud users. Non-blocking.
  void ensureServingIfProvisioned(binDir(), info.url);
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

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
