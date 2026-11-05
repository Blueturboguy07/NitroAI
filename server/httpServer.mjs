/* The local server the desktop shell runs. Serves the built SPA (dist/) and the
 * native-helper endpoints the browser can't do itself:
 *   GET  /api/health               → liveness (the shell polls this)
 *   POST /api/youtube-extract       → yt-dlp captions/audio; body {"url": "..."}
 *   GET  /api/fetch-page?url=      → a web page's bytes for the link reader (see fetchPage.mjs)
 *   GET  /api/local/status         → Ollama provisioning state
 *   POST /api/local/setup          → SSE stream that installs/starts/pulls Ollama
 *   *    /api/publik/*              → publik API credential + streaming proxy (see publikProxy.mjs)
 *
 * Every /api/* request passes ONE guard first (localGuard.mjs): Host, the
 * app-only header, Sec-Fetch-Site, Origin and Content-Type. A GET never
 * changes state: the two routes that download or install are POST.
 *
 * Pure Node built-ins, no framework, so the packaged app stays small and has
 * no extra supply chain. Exported as startServer() so both the Electron main
 * process and a plain `node server/standalone.mjs` can run it.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanOldYtdlp, extractYoutube } from "./ytdlp.mjs";
import { provision, status } from "./ollama.mjs";
import { createPublikHandler } from "./publikProxy.mjs";
import { handleFetchPage } from "./fetchPage.mjs";
import { refuseLocalRequest, sendRefused } from "./localGuard.mjs";
import { checkYoutubeLink } from "./youtubeLink.mjs";

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

/* A small JSON body (the youtube-extract URL). {} when empty or not JSON. */
function readSmallJson(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(v && typeof v === "object" ? v : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

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

  if (await opts.publik(req, res, url)) return;

  if (p === "/api/fetch-page") return handleFetchPage(req, res, url, opts.fetchPage);

  if (p === "/api/youtube-extract") {
    // POST: on first use it downloads yt-dlp, and it always downloads media.
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
    const { url: target } = await readSmallJson(req);
    // Only a YouTube link (youtubeLink.mjs): never 127.0.0.1 or another
    // site, and never a value that starts with "-" (ytdlp.mjs also puts "--"
    // before the link).
    const link = checkYoutubeLink(target);
    if (link.error) return sendJson(res, 400, { error: link.error });
    try {
      const result = await extractYoutube(link.url, opts.binDir);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 502, { error: err instanceof Error ? err.message : "extraction failed" });
    }
  }

  if (p === "/api/local/status") {
    // Optional overrides so status reflects the model the CALLER actually
    // wants (e.g. one they picked or already pulled before), not just our
    // shipped default — see server/ollama.mjs status() for why that matters.
    const chatModel = url.searchParams.get("chatModel") || undefined;
    const embedModel = url.searchParams.get("embedModel") || undefined;
    try {
      return sendJson(res, 200, await status(opts.binDir, chatModel, embedModel));
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : "status failed" });
    }
  }

  if (p === "/api/local/setup") {
    // POST: it installs, starts and pulls Ollama (a 150 MB download and more).
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
    // Server-Sent Events: provisions Ollama and streams progress. Called ONLY
    // when the user has chosen the local engine. chatModel/embedModel let the
    // caller pull a specific model (from a picker, or a previously-chosen one)
    // instead of always the hardcoded default.
    const input = await readSmallJson(req);
    const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const chatModel = pick(input.chatModel);
    const embedModel = pick(input.embedModel);
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
        models: chatModel || embedModel ? { chat: chatModel, embed: embedModel } : undefined,
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

/* The desktop shell's preferred ports. Chromium keys localStorage and
   IndexedDB by origin INCLUDING the port, so an OS-assigned port (0) would give
   the renderer a fresh, empty origin on every launch — prefs, notes and the
   BYO key gone. A fixed port keeps the origin stable across launches; the
   small fallback range only matters when something else holds the first one
   (then that launch lands on a different origin, which is the pre-existing
   behaviour, not a regression). 0 is the last resort. */
export const STABLE_PORTS = [41763, 41764, 41765, 41766, 41767, 41768, 41769, 41770, 41771, 41772, 0];

/* Start the server. Returns { server, port, url }. `distDir` defaults to the
   sibling dist/ (works in dev and when packaged with app.asar layout).
   `ports` — try each candidate in order (EADDRINUSE → next); `port` is the
   one-candidate shorthand. `publik` — { token, appVersion, credentialFile?,
   baseUrl?, fetchImpl? } for the publik credential + proxy routes.
   `fetchPage` — { maxBytes?, timeoutMs?, resolve?, allowHosts? } for
   /api/fetch-page (tests only; see fetchPage.mjs). */
export function startServer({ distDir, binDir, port = 0, ports, host = "127.0.0.1", publik = {}, fetchPage = {} } = {}) {
  const resolvedDist = distDir ?? path.join(__dirname, "..", "dist");
  const candidates = Array.isArray(ports) && ports.length ? ports : [port];
  const handlePublik = createPublikHandler(publik);
  // Startup: the old unversioned bin/yt-dlp (v0.2.1, v0.2.2) is never run.
  // Delete it now (see ytdlp.mjs).
  if (binDir) cleanOldYtdlp(binDir);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname.startsWith("/api/")) {
      const refused = refuseLocalRequest(req, url.pathname, server.address()?.port);
      if (refused) return sendRefused(res, refused);
      const appOrigin = `http://${host}:${server.address()?.port ?? candidates[0]}`;
      handleApi(req, res, url, { binDir, appOrigin, publik: handlePublik, fetchPage }).catch((err) =>
        sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" }),
      );
      return;
    }
    serveStatic(resolvedDist, url.pathname, res);
  });

  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      const candidate = candidates[i++];
      const onError = (err) => {
        if (err?.code === "EADDRINUSE" && i < candidates.length) return tryNext();
        reject(err);
      };
      server.once("error", onError);
      server.listen(candidate, host, () => {
        server.removeListener("error", onError);
        const actualPort = server.address().port;
        resolve({ server, port: actualPort, url: `http://${host}:${actualPort}` });
      });
    };
    tryNext();
  });
}
