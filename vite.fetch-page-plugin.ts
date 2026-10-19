/* "Import from URL" for `vite dev` / `vite preview`.
 *
 * Browsers block the renderer from reading almost any other site (no CORS
 * headers), so pages are fetched server-side. This plugin exposes
 * GET /api/fetch-page?url=… during dev/preview, backed by the exact same
 * SSRF-guarded fetch the packaged desktop shell uses (server/fetchPage.mjs):
 * http/https only, private/loopback/link-local addresses refused after DNS
 * resolution, redirects re-checked, 5 MB / 15 s caps. Same caller checks as
 * the packaged server too (server/requestGuard.mjs).
 */

import type { Connect, Plugin } from "vite";
import type { ServerResponse } from "node:http";
// @ts-ignore — plain-JS Node module, no type declarations
import { fetchPageResponse } from "./server/fetchPage.mjs";
// @ts-ignore — plain-JS Node module, no type declarations
import { checkApiRequest } from "./server/requestGuard.mjs";

function middleware(): Connect.NextHandleFunction {
  return (req, res: ServerResponse, next) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname !== "/api/fetch-page") return next();

    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
    };

    const refused = checkApiRequest(req, reqUrl.pathname, {
      extraHosts: [process.env.TAURI_DEV_HOST],
    }) as { status: number; error: string } | null;
    if (refused) return send(refused.status, { error: refused.error });
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      return send(405, { error: "method not allowed" });
    }

    (fetchPageResponse(reqUrl.searchParams.get("url")) as Promise<{ status: number; body: unknown }>)
      .then((r) => send(r.status, r.body))
      .catch((err: unknown) => send(502, { error: err instanceof Error ? err.message : "fetch failed" }));
  };
}

export function fetchPagePlugin(): Plugin {
  return {
    name: "nitroai-fetch-page",
    configureServer(server) {
      server.middlewares.use(middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware());
    },
  };
}
