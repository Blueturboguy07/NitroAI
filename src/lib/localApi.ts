/* The app-only header for the local server's /api/* routes.
 *
 * The local server (server/httpServer.mjs) refuses every /api/* request that
 * does not carry `x-nitroai-app: 1` (server/localGuard.mjs). A web page on
 * another site cannot send a custom header to 127.0.0.1 without a CORS
 * preflight, and the server never approves one. So every renderer call to a
 * local /api/* route goes through localFetch(), and the publik engine adds
 * the header when its base URL is the local proxy.
 *
 * A request with a body is sent as application/json (the server refuses
 * other content types), except a FormData body, which the browser sends as
 * multipart/form-data (the audio upload). */

export const APP_HEADER = "x-nitroai-app";

/* True for "/api/…" and for "http://127.0.0.1:<port>/api/…" or
   "http://localhost:<port>/api/…" — the local server, never api.openai.com. */
export function isLocalApi(url: string): boolean {
  return /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?)?\/api\//i.test(url);
}

/* `headers` plus the app header. */
export function withAppHeader(headers?: HeadersInit): Headers {
  const h = new Headers(headers);
  h.set(APP_HEADER, "1");
  return h;
}

/* fetch() for the local server's /api/* routes. A POST with no body gets
   "{}" and Content-Type application/json, so the server's check passes. */
export function localFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = withAppHeader(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  if (method !== "GET" && method !== "HEAD") {
    if (body === undefined || body === null) body = "{}";
    if (!(body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return fetch(path, { ...init, method, headers, body });
}
