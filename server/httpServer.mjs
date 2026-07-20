/* The local server the desktop shell runs. Serves the built SPA (dist/) and the
 * native-helper endpoints the browser can't do itself:
 *   GET  /api/health               → liveness (the shell polls this)
 *   GET  /api/youtube-extract?url= → yt-dlp captions/audio
 *   GET  /api/local/status         → Ollama provisioning state
 *   GET  /api/local/setup          → SSE stream that installs/starts/pulls Ollama
 *
 * Pure Node built-ins, no framework, so the packaged app stays small and has
 * no extra supply chain. Exported as startServer() so both the Electron main
 * process and a plain `node server/standalone.mjs` can run it.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractYoutube } from "./ytdlp.mjs";
import { provision, status } from "./ollama.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/* Serve a static file from dist/, defending against path traversal, with SPA
   fallback to index.html for client routes. */
function serveStatic(distDir, urlPath, res) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.normalize(path.join(distDir, clean));
  if (!resolved.startsWith(distDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  let filePath = resolved;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA routes (e.g. /notes/:id/editor) have no file — serve the app shell.
    filePath = path.join(distDir, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url, opts) {
  const p = url.pathname;

  if (p === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "nitroai" });
  }

  if (p === "/api/youtube-extract") {
    const target = url.searchParams.get("url");
    if (!target) return sendJson(res, 400, { error: "missing url parameter" });
    try {
      const result = await extractYoutube(target, opts.binDir);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 502, { error: err instanceof Error ? err.message : "extraction failed" });
    }
  }

  if (p === "/api/local/status") {
    try {
      return sendJson(res, 200, await status(opts.binDir));
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : "status failed" });
    }
  }

  if (p === "/api/local/setup") {
    // Server-Sent Events: provisions Ollama and streams progress. Called ONLY
    // when the user has chosen the local engine.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      const result = await provision({
        binDir: opts.binDir,
        appOrigin: opts.appOrigin,
        emit,
      });
      emit({ phase: "done", ...result });
    } catch (err) {
      emit({ phase: "error", message: err instanceof Error ? err.message : "setup failed" });
    }
    return res.end();
  }

  return sendJson(res, 404, { error: "unknown endpoint" });
}

/* Start the server. Returns { server, port, url }. `distDir` defaults to the
   sibling dist/ (works in dev and when packaged with app.asar layout). */
export function startServer({ distDir, binDir, port = 0, host = "127.0.0.1" } = {}) {
  const resolvedDist = distDir ?? path.join(__dirname, "..", "dist");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname.startsWith("/api/")) {
      const appOrigin = `http://${host}:${server.address()?.port ?? port}`;
      handleApi(req, res, url, { binDir, appOrigin }).catch((err) =>
        sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" }),
      );
      return;
    }
    serveStatic(resolvedDist, url.pathname, res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({ server, port: actualPort, url: `http://${host}:${actualPort}` });
    });
  });
}
