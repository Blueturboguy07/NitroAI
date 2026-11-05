/* The ONE guard in front of every /api/* route of the local server (and the
 * dev server's /api/youtube-extract). The local server listens on
 * 127.0.0.1, but any web page the user opens in a browser can still send
 * requests to it, and a page whose DNS name is pointed at 127.0.0.1 (DNS
 * rebinding) can even read the answers. Before this guard, a page on any
 * site could POST /api/publik/chat (spends the user's balance), POST
 * /api/publik/disconnect (revokes the install and deletes the credential),
 * read /api/publik/status and /wallet, and start an Ollama download with a
 * GET to /api/local/setup.
 *
 * A request is refused (403) unless ALL of these hold:
 *   - Host is 127.0.0.1:<port> or localhost:<port> (DNS rebinding sends the
 *     attacker's name);
 *   - the app-only header x-nitroai-app: 1 is set (a page on another origin
 *     cannot send it without a CORS preflight, and this server never
 *     approves one: there is no CORS header on any answer);
 *   - Sec-Fetch-Site, when the browser sends it, is not cross-site or
 *     same-site;
 *   - Origin, when sent, is this server's own origin;
 *   - a request that is not GET or HEAD has Content-Type application/json
 *     (multipart/form-data only for the audio upload path); OPTIONS is
 *     refused.
 * The routes themselves make no state change on GET.
 *
 * Pure Node; no imports. */

export const APP_HEADER = "x-nitroai-app";

/* The one path that sends a file as multipart/form-data. */
const MULTIPART_PATHS = new Set(["/api/publik/v1/audio/transcriptions"]);

/* Returns null when the request may go on, else a short reason. `port` is
   the port this server listens on; `extraHosts` are more host names that
   are this machine (the dev server's TAURI_DEV_HOST). */
export function refuseLocalRequest(req, pathname, port, extraHosts = []) {
  const names = ["127.0.0.1", "localhost", ...extraHosts.filter(Boolean)];
  const hosts = new Set(names.map((n) => `${n}:${port}`.toLowerCase()));
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  const host = String(req.headers.host ?? "").toLowerCase();
  if (!port || !hosts.has(host)) return "host";
  if (req.headers[APP_HEADER] !== "1") return "app header";
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return "sec-fetch-site";
  const origin = req.headers.origin;
  if (origin !== undefined && !origins.has(String(origin).toLowerCase())) return "origin";

  const method = String(req.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") return "method";
  if (method !== "GET" && method !== "HEAD") {
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const multipartOk = type === "multipart/form-data" && MULTIPART_PATHS.has(pathname);
    if (type !== "application/json" && !multipartOk) return "content-type";
  }
  return null;
}

/* Sends the 403. No CORS header, so a browser never shows it to a page on
   another origin. */
export function sendRefused(res, reason) {
  res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "forbidden", reason }));
}
