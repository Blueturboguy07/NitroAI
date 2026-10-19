/* Who may call the local server's /api/* routes.
 *
 * The server listens on 127.0.0.1, but that alone doesn't keep other websites
 * out: any page the user visits can fire requests at http://127.0.0.1:<port>
 * (simple GETs/POSTs need no CORS preflight), and a DNS-rebinding page can even
 * read the answers. So every API request must pass:
 *
 *   1. Host     — the Host header names a loopback host (127.0.0.1, localhost,
 *                 [::1]) or an explicitly allowed dev host. A rebinding page's
 *                 requests carry ITS hostname here, so they're refused.
 *   2. Origin   — when present, it must be exactly our own origin
 *                 (http://<Host>). Browsers send Origin on every cross-origin
 *                 request and on every non-GET request, so cross-site POSTs
 *                 can't get through.
 *   3. Sec-Fetch-Site — when present (all current Chromium/Electron, Firefox,
 *                 Safari), it must be "same-origin" (or "none": typed into
 *                 the address bar).
 *   4. X-NitroAI: 1 — a custom header. A cross-origin page can only send it
 *                 after a CORS preflight, which we never answer, so requiring
 *                 it closes the "no Origin on a simple GET" gap (img/script
 *                 tags, no-cors fetch).
 *
 * The OpenAI-compatible publik passthrough (/api/publik/v1/*, /api/publik/chat)
 * is driven by the generic OpenAI client, which doesn't add our header; it is
 * accepted with a positive same-origin signal instead (a matching Origin or
 * Sec-Fetch-Site: same-origin). /api/health is open to header-less callers
 * (the Electron main process polls it) but still gets the Host/Origin checks.
 *
 * Pure, framework-free, shared by server/httpServer.mjs and the vite plugins. */

export const CLIENT_HEADER = "x-nitroai";
export const CLIENT_HEADER_VALUE = "1";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/* "127.0.0.1:41763" → "127.0.0.1"; "[::1]:5" → "[::1]". Null when unparsable. */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedHost(hostHeader, extraHosts = []) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (LOOPBACK_HOSTNAMES.has(name)) return true;
  return extraHosts.some((h) => typeof h === "string" && h && h.toLowerCase() === name);
}

/* Paths the generic OpenAI client calls (no custom header there). */
function isOpenAiPassthrough(pathname) {
  return pathname === "/api/publik/chat" || pathname.startsWith("/api/publik/v1/");
}

/* Returns null when the request may proceed, or { status, error } to refuse.
   `extraHosts` — additional allowed Host names (e.g. TAURI_DEV_HOST in dev). */
export function checkApiRequest(req, pathname, { extraHosts = [] } = {}) {
  const h = req.headers ?? {};
  const host = h.host;
  if (!isAllowedHost(host, extraHosts)) {
    return { status: 403, error: "forbidden_host" };
  }

  const origin = h.origin;
  const sameOrigin = typeof origin === "string" && origin === `http://${host}`;
  if (origin !== undefined && !sameOrigin) {
    return { status: 403, error: "forbidden_origin" };
  }

  const site = h["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { status: 403, error: "forbidden_origin" };
  }

  if (pathname === "/api/health") return null;

  if (h[CLIENT_HEADER] === CLIENT_HEADER_VALUE) return null;
  if (isOpenAiPassthrough(pathname) && (sameOrigin || site === "same-origin")) return null;
  return { status: 403, error: "missing_client_header" };
}
