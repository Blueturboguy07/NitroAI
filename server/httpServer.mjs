/* The local server the desktop shell runs. Serves the built SPA (dist/) and the
 * native-helper endpoints the browser can't do itself:
 *   GET  /api/health               → liveness (the shell polls this)
 *   POST /api/youtube-extract       → yt-dlp captions/audio; body {"url": "..."}
 *   GET  /api/fetch-page?url=      → a web page's bytes for the link reader (see fetchPage.mjs)
 *   GET  /api/local/status         → Ollama provisioning state
 *   POST /api/local/setup          → SSE stream that installs/starts/pulls Ollama
 *   *    /api/lecture/*            → "Trim the solve-time gaps": download, cut, play (see lecture.mjs)
 *   POST /api/explainer/render     → slides + voice → one .mp4 (see explainer.mjs)
 *   *    /api/publik/*              → publik API credential + streaming proxy (see publikProxy.mjs),
 *                                    and the library backup under /api/publik/backup (see publikBackup.mjs)
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
import { createLectureHandler } from "./lecture.mjs";
import { createExplainerHandler } from "./explainer.mjs";

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

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false; // not there, not readable, or not a path (a NUL byte)
  }
}

/* An error after the request started: a JSON 500, or a cut connection when
   the answer has already begun. Never throws. */
function failRequest(res, err) {
  try {
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  } catch {
    res.destroy();
  }
}

/* Serve a static file from dist/, defending against path traversal, with SPA
   fallback to index.html for client routes. Never throws: a path that cannot
   be decoded is a 400, a file that cannot be read is a 404. */
function serveStatic(distDir, urlPath, res) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  const resolved = path.normalize(path.join(distDir, clean));
  if (!resolved.startsWith(distDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  let filePath = resolved;
  // SPA routes (e.g. /notes/:id/editor) have no file — serve the app shell.
  if (!isFile(filePath)) filePath = path.join(distDir, "index.html");
  if (!isFile(filePath)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  // The headers go out only when the file is open. A stream error with no
  // listener is an uncaught exception, and this server runs in the app's
  // main process.
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(404).end("Not found");
  });
  stream.once("open", () => {
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    stream.pipe(res);
  });
  res.on("close", () => stream.destroy());
}

async function handleApi(req, res, url, opts) {
  const p = url.pathname;

  if (p === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "nitroai" });
  }

  if (await opts.publik(req, res, url)) return;

  if (p === "/api/fetch-page") return handleFetchPage(req, res, url, opts.fetchPage);

  if (await opts.lecture(req, res, url)) return;
  if (await opts.explainer(req, res, url)) return;

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
   `ports` — try each candidate in order (a refused port → next); `port` is the
   one-candidate shorthand. `publik` — { token, appVersion, credentialFile?,
   baseUrl?, fetchImpl? } for the publik credential + proxy routes.
   `fetchPage` — { maxBytes?, timeoutMs?, resolve?, allowHosts? } for
   /api/fetch-page (tests only; see fetchPage.mjs).
   `mediaDir` — where the trimmed lecture videos are kept; `lecture` —
   { ffmpeg?, ytdlp?, trim? } for /api/lecture/* (tests only; see lecture.mjs);
   `explainer` — { ffmpeg?, render? } for /api/explainer/* (tests only);
   `onError` — gets every error a request (or the server) had; the desktop
   shell writes it to its crash log. */
export function startServer({ distDir, binDir, mediaDir, port = 0, ports, host = "127.0.0.1", publik = {}, fetchPage = {}, lecture = {}, explainer = {}, onError = () => {} } = {}) {
  const report = (err) => {
    try {
      onError(err);
    } catch {
      /* the reporter must not be a new error */
    }
  };
  const resolvedDist = distDir ?? path.join(__dirname, "..", "dist");
  const candidates = Array.isArray(ports) && ports.length ? ports : [port];
  const handlePublik = createPublikHandler(publik);
  const handleLecture = createLectureHandler({ ...lecture, binDir, mediaDir });
  const handleExplainer = createExplainerHandler({ ...explainer, mediaDir });
  // Startup: the old unversioned bin/yt-dlp (v0.2.1, v0.2.2) is never run.
  // Delete it now (see ytdlp.mjs).
  if (binDir) cleanOldYtdlp(binDir);

  // Nothing may throw out of this listener: in the desktop app that is an
  // uncaught exception in the Electron main process.
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
    } catch {
      res.writeHead(400).end("Bad request"); // "//" and the like: not a URL
      return;
    }
    try {
      if (url.pathname.startsWith("/api/")) {
        const refused = refuseLocalRequest(req, url.pathname, server.address()?.port);
        if (refused) return sendRefused(res, refused);
        const appOrigin = `http://${host}:${server.address()?.port ?? candidates[0]}`;
        handleApi(req, res, url, { binDir, appOrigin, publik: handlePublik, fetchPage, lecture: handleLecture, explainer: handleExplainer }).catch((err) => {
          report(err);
          failRequest(res, err);
        });
        return;
      }
      serveStatic(resolvedDist, url.pathname, res);
    } catch (err) {
      report(err);
      failRequest(res, err);
    }
  });

  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      const candidate = candidates[i++];
      const onError = (err) => {
        // Any refusal moves on to the next port, not only "in use": Windows
        // answers EACCES for a port inside a reserved range.
        if (i < candidates.length) return tryNext();
        reject(err);
      };
      server.once("error", onError);
      server.listen(candidate, host, () => {
        server.removeListener("error", onError);
        // A later 'error' with no listener would be an uncaught exception.
        server.on("error", report);
        const actualPort = server.address().port;
        resolve({ server, port: actualPort, url: `http://${host}:${actualPort}` });
      });
    };
    tryNext();
  });
}

/* Stop the server NOW. server.close() alone waits for every open request (a
   progress stream, a video being played), so the app could not quit;
   closeAllConnections() ends them. Resolves when the server is closed. Safe
   to call twice, and with nothing. */
export function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch {
      resolve();
    }
  });
}
