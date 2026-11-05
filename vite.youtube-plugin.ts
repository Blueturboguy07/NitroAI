/* Local YouTube extraction for `vite dev` / `vite preview`.
 *
 * YouTube's PoToken/BotGuard gate returns empty captions to any in-browser
 * fetch, so the SPA alone can't ingest YouTube links. This plugin exposes
 * POST /api/youtube-extract (body {"url": "..."}) during dev/preview, backed
 * by the exact same yt-dlp logic the packaged desktop shell uses
 * (server/ytdlp.mjs) — captions first, audio fallback, yt-dlp auto-downloaded
 * on first use. Only a purely static deployment (no local server, no desktop
 * shell) is left without a YouTube path.
 *
 * The same guard as the desktop server (server/localGuard.mjs) runs first:
 * Host, the app-only header, Sec-Fetch-Site, Origin and Content-Type. A web
 * page on another site cannot start a download here.
 */

import path from "node:path";
import type { Connect, Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
// @ts-expect-error — plain-JS Node module, no type declarations
import { extractYoutube } from "./server/ytdlp.mjs";
// @ts-expect-error — plain-JS Node module, no type declarations
import { refuseLocalRequest, sendRefused } from "./server/localGuard.mjs";

const CACHE_DIR = path.join(process.cwd(), "node_modules", ".cache", "nitroai");
const MAX_BODY = 16 * 1024;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
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

function middleware(): Connect.NextHandleFunction {
  return (req, res: ServerResponse, next) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname !== "/api/youtube-extract") return next();

    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
    };

    const refused = refuseLocalRequest(req, reqUrl.pathname, req.socket.localPort, [process.env.TAURI_DEV_HOST]);
    if (refused) return sendRefused(res, refused);
    if (req.method !== "POST") return send(405, { error: "use POST" });

    void readJson(req).then(({ url: target }) => {
      if (typeof target !== "string" || !target) return send(400, { error: "missing url" });
      let link: URL;
      try {
        link = new URL(target);
      } catch {
        return send(400, { error: "not a link" });
      }
      if (link.protocol !== "http:" && link.protocol !== "https:") return send(400, { error: "not a link" });
      extractYoutube(target, CACHE_DIR)
        .then((result: unknown) => send(200, result))
        .catch((err: unknown) => send(502, { error: err instanceof Error ? err.message : "extraction failed" }));
    });
  };
}

export function youtubeExtractPlugin(): Plugin {
  return {
    name: "nitroai-youtube-extract",
    configureServer(server) {
      server.middlewares.use(middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware());
    },
  };
}
