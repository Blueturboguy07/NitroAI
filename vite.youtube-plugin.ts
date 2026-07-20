/* Local YouTube extraction for `vite dev` / `vite preview`.
 *
 * YouTube's PoToken/BotGuard gate returns empty captions to any in-browser
 * fetch, so the SPA alone can't ingest YouTube links. This plugin exposes
 * GET /api/youtube-extract?url=… during dev/preview, backed by the exact same
 * yt-dlp logic the packaged desktop shell uses (server/ytdlp.mjs) — captions
 * first, audio fallback, yt-dlp auto-downloaded on first use. Only a purely
 * static deployment (no local server, no desktop shell) is left without a
 * YouTube path.
 */

import path from "node:path";
import type { Connect, Plugin } from "vite";
import type { ServerResponse } from "node:http";
// @ts-expect-error — plain-JS Node module, no type declarations
import { extractYoutube } from "./server/ytdlp.mjs";

const CACHE_DIR = path.join(process.cwd(), "node_modules", ".cache", "nitroai");

function middleware(): Connect.NextHandleFunction {
  return (req, res: ServerResponse, next) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname !== "/api/youtube-extract") return next();
    const target = reqUrl.searchParams.get("url");

    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
    };

    if (!target) return send(400, { error: "missing url parameter" });
    extractYoutube(target, CACHE_DIR)
      .then((result: unknown) => send(200, result))
      .catch((err: unknown) =>
        send(502, { error: err instanceof Error ? err.message : "extraction failed" }),
      );
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
