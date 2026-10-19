import type { IngestResult } from "./index";

/* Element/tag noise that shouldn't leak into extracted body text. */
const STRIP_SELECTOR = "script, style, nav, noscript, iframe, svg, header, footer";

/* Sent on every call to the app's own /api/* routes; the local server refuses
   requests without it (see server/requestGuard.mjs). */
const API_HEADERS = { "X-NitroAI": "1" };

/* The local server (desktop shell, `npm run serve`, or `vite dev`/`preview`)
   fetches the page for us — the renderer can't, because almost no site sends
   CORS headers. Returns null only when no such server answers here (a purely
   static deployment), so the caller can fall back. */
async function fetchViaLocalServer(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`/api/fetch-page?url=${encodeURIComponent(url)}`, {
      headers: API_HEADERS,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Couldn't import "${url}": the page took too long to load.`);
    }
    return null;
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) return null; // a static host's SPA fallback — no local server here
  let body: { html?: string; error?: string };
  try {
    body = (await res.json()) as { html?: string; error?: string };
  } catch {
    throw new Error(`Couldn't import "${url}": the local server sent an unreadable answer.`);
  }
  if (!res.ok || typeof body.html !== "string") {
    throw new Error(`Couldn't import "${url}": ${body.error ?? `the local server answered ${res.status}.`}`);
  }
  return body.html;
}

/* Static deployments only: try the site directly. This works just for the
   rare site that allows cross-origin reads, so the error says exactly that
   rather than blaming the user's connection. */
async function fetchDirect(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(
      `Couldn't import "${url}": this site doesn't let other web pages read it, and this version of NitroAI ` +
        "has no local server to fetch it for you. Use the NitroAI desktop app (or run it locally with " +
        "`npm run dev`), or copy the page's text and paste it in instead.",
    );
  }
  if (!res.ok) {
    throw new Error(`Couldn't import "${url}": the site answered with HTTP ${res.status}.`);
  }
  return res.text();
}

export async function ingestUrl(url: string): Promise<IngestResult> {
  if (typeof DOMParser === "undefined") {
    throw new Error("Fetching web pages is only supported in the browser.");
  }
  if (typeof fetch === "undefined") {
    throw new Error("Network access is unavailable in this environment.");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" isn't a valid web address. Include the https:// part.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Couldn't import "${url}": only http:// and https:// links can be imported.`);
  }

  const html = (await fetchViaLocalServer(url)) ?? (await fetchDirect(url));

  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());

  const title =
    doc.querySelector("title")?.textContent?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    undefined;

  const text = (doc.body?.textContent ?? "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`Couldn't find readable text on "${url}".`);
  }

  return { text, title, meta: { url } };
}
