/* The local server the desktop shell runs. Serves the built SPA (dist/) and the
 * native-helper endpoints the browser can't do itself:
 *   GET  /api/health               → liveness (the shell polls this)
 *   POST /api/youtube-extract?url= → yt-dlp captions/audio (YouTube URLs only)
 *   GET  /api/fetch-page?url=      → fetch a web page for "Import from URL" (SSRF-guarded, see fetchPage.mjs)
 *   GET  /api/local/status         → Ollama provisioning state
 *   POST /api/local/setup          → SSE stream that installs/starts/pulls Ollama
 *   *    /api/publik/*              → publik API credential + streaming proxy (see publikProxy.mjs)
 *
 * Every /api/* request must come from the app itself — loopback Host, our own
 * Origin, and the X-NitroAI: 1 header (see requestGuard.mjs) — so other
 * websites the user visits can't drive these endpoints.
 *
 * Pure Node built-ins, no framework, so the packaged app stays small and has
 * no extra supply chain. Exported as startServer() so both the Electron main
 * process and a plain `node server/standalone.mjs` can run it.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageResponse } from "./fetchPage.mjs";
import { checkApiRequest } from "./requestGuard.mjs";
import { extractYoutube } from "./ytdlp.mjs";
import { provision, status } from "./ollama.mjs";
import { createPublikHandler } from "./publikProxy.mjs";

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
  // pdf.js runtime data copied to dist/pdfjs/ by vite.pdfjs-plugin.ts
  ".bcmap": "application/octet-stream",
  ".pfb": "application/x-font-type1",
  ".icc": "application/vnd.iccprofile",
};

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allow) {
  return sendJson(res, 405, { error: "method not allowed" }, { allow });
}

/* Serve a static file from dist/, defending against path traversal, with SPA
   fallback to index.html for client routes. */
function serveStatic(distDir, urlPath, res) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    // Malformed %-escape (e.g. "/%E0%A4%A") — a bad request, not a crash.
    res.writeHead(400).end("Bad Request");
    return;
  }
  if (clean.includes("\0")) {
    res.writeHead(400).end("Bad Request");
    return;
  }
  const root = path.resolve(distDir);
  const resolved = path.resolve(path.join(root, clean));
  const rel = path.relative(root, resolved);
  // Inside root means: not "..", not starting with "../", not absolute (another
  // drive on Windows). A bare prefix check would let /dist-evil/ through.
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  let filePath = resolved;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA routes (e.g. /notes/:id/editor) have no file — serve the app shell.
    filePath = path.join(root, "index.html");
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
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function handleApi(req, res, url, opts) {
  const p = url.pathname;

  const refused = checkApiRequest(req, p);
  if (refused) return sendJson(res, refused.status, { error: refused.error });

  if (p === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "nitroai" });
  }

  if (await opts.publik(req, res, url)) return;

  if (p === "/api/youtube-extract") {
    // POST: it downloads yt-dlp and spawns processes.
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const target = url.searchParams.get("url");
    if (!target) return sendJson(res, 400, { error: "missing url parameter" });
    try {
      const result = await extractYoutube(target, opts.binDir);
      return sendJson(res, 200, result);
    } catch (err) {
      const status = err?.code === "invalid_youtube_url" ? 400 : 502;
      return sendJson(res, status, { error: err instanceof Error ? err.message : "extraction failed" });
    }
  }

  if (p === "/api/fetch-page") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const r = await fetchPageResponse(url.searchParams.get("url"), opts.fetchPage);
    return sendJson(res, r.status, r.body);
  }

  if (p === "/api/local/status") {
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
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
    // POST only: this installs Ollama and pulls multi-GB models.
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    // Server-Sent Events: provisions Ollama and streams progress. Called ONLY
    // when the user has chosen the local engine. chatModel/embedModel let the
    // caller pull a specific model (from a picker, or a previously-chosen one)
    // instead of always the hardcoded default.
    const chatModel = url.searchParams.get("chatModel") || undefined;
    const embedModel = url.searchParams.get("embedModel") || undefined;
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
   `fetchPage` — test-only overrides for /api/fetch-page (see fetchPage.mjs). */
export function startServer({ distDir, binDir, port = 0, ports, host = "127.0.0.1", publik = {}, fetchPage } = {}) {
  const resolvedDist = distDir ?? path.join(__dirname, "..", "dist");
  const candidates = Array.isArray(ports) && ports.length ? ports : [port];
  const handlePublik = createPublikHandler(publik);

  /* Nothing a single request does may take the process down — in Electron
     this is the main process, so a throw here would kill the whole app. */
  const fail = (res, err) => {
    try {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    } catch {
      res.destroy();
    }
  };

  const server = http.createServer((req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url ?? "/", `http://${host}`);
      } catch {
        return sendJson(res, 400, { error: "bad request" });
      }
      if (url.pathname.startsWith("/api/")) {
        const appOrigin = `http://${host}:${server.address()?.port ?? candidates[0]}`;
        handleApi(req, res, url, { binDir, appOrigin, publik: handlePublik, fetchPage }).catch((err) => fail(res, err));
        return;
      }
      serveStatic(resolvedDist, url.pathname, res);
    } catch (err) {
      fail(res, err);
    }
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
