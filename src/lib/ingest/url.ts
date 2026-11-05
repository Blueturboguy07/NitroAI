import type { IngestResult } from "./index";
import { MAX_TEXT_FILE_BYTES, inspectText, zipFlavor } from "./fileTypes";
import { cutTitle } from "./text";

/* Stop downloading a page at this size (the local server has the same
   limit, server/fetchPage.mjs). The 2 MB limit applies to the text NitroAI
   reads from the page (the same limit as a .txt file): the markup of a long
   article can be over 2 MB while its text is far less. */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;

const LINK_HELP = "Paste a link to a web page or a YouTube video.";

export const LINK_SCHEME_MESSAGE = `NitroAI reads http and https links only. ${LINK_HELP}`;
export const PAGE_DOWNLOAD_TOO_LARGE_MESSAGE = `That page is more than 8 MB to download, and NitroAI downloads up to 8 MB from a link. Save the part you need as a .txt or PDF file and upload that.`;
export const PAGE_TEXT_TOO_LARGE_MESSAGE = `That page has more than 2 MB of text, and NitroAI reads up to 2 MB. Save the part you need as a .txt or PDF file and upload that.`;

class LinkError extends Error {}

/* The body, read up to `max` bytes; null when the page is larger. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* The page bytes, from the app's local server (GET /api/fetch-page): a
   fetch() from the renderer fails with "Failed to fetch" on most sites,
   because they send no CORS header for the app's origin. A host without
   that route (the plain web build) answers with its SPA page instead; then
   the renderer fetches the page itself, as before. `bytes` is null when the
   page is larger than MAX_PAGE_BYTES. */
async function download(url: string): Promise<{ bytes: Uint8Array | null; contentType: string | null }> {
  let res: Response | null = null;
  try {
    res = await fetch(`/api/fetch-page?url=${encodeURIComponent(url)}`, { headers: { "x-nitroai-fetch": "1" } });
  } catch {
    res = null;
  }
  if (res && res.headers.get("x-nitroai-page") === "1") {
    if (res.ok) return { bytes: await readCapped(res, MAX_PAGE_BYTES), contentType: res.headers.get("x-nitroai-content-type") };
    const body = (await res.json().catch(() => ({}))) as { error?: string; status?: number; reason?: string };
    if (body.error === "too_large") return { bytes: null, contentType: null };
    if (body.error === "bad_scheme") throw new LinkError(LINK_SCHEME_MESSAGE);
    if (body.error === "status") throw new Error(`server responded with ${body.status}`);
    if (body.error === "timeout") throw new Error("the site took too long to answer");
    throw new Error(body.reason ?? "the site could not be reached");
  }
  const direct = await fetch(url);
  if (!direct.ok) throw new Error(`server responded with ${direct.status}`);
  return { bytes: await readCapped(direct, MAX_PAGE_BYTES), contentType: direct.headers.get("content-type") };
}

function decodePage(bytes: Uint8Array, contentType: string | null, fallback: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      /* unknown label: use the shared decoding */
    }
  }
  return fallback;
}

/* Element/tag noise that shouldn't leak into extracted body text. */
const STRIP_SELECTOR = "script, style, nav, noscript, iframe, svg, header, footer";

export async function ingestUrl(url: string): Promise<IngestResult> {
  if (typeof DOMParser === "undefined") {
    throw new Error("Fetching web pages is only supported in the browser.");
  }
  if (typeof fetch === "undefined") {
    throw new Error("Network access is unavailable in this environment.");
  }

  let parsed: URL;
  try {
    // "en.wikipedia.org/wiki/X" (no scheme) means https. Before, it was
    // fetched as a path on the app's own server.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch {
    throw new Error(`"${url}" is not a link. ${LINK_HELP}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(LINK_SCHEME_MESSAGE);

  let bytes: Uint8Array | null;
  let contentType: string | null;
  try {
    ({ bytes, contentType } = await download(parsed.href));
  } catch (err) {
    if (err instanceof LinkError) throw new Error(err.message);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't fetch "${url}" (${reason}). Check the URL and your connection.`);
  }
  if (!bytes) throw new Error(PAGE_DOWNLOAD_TOO_LARGE_MESSAGE);

  /* The same check as a .txt upload. Before, a link to an image or a PDF
     was read as text and sent to the model (paid calls of garbage). */
  const found = inspectText(bytes);
  if (!found.ok) {
    if (found.signature === "pdf") {
      throw new Error("That link is a PDF file, not a web page. Download it, then add it with \"Document upload\".");
    }
    if (found.signature === "zip" && zipFlavor(bytes) === "word") {
      throw new Error("That link is a Word file, not a web page. Download it, then add it with \"Document upload\".");
    }
    throw new Error(`That link is ${found.signature ? found.words : "not a web page (it contains binary data)"}${found.signature ? ", not a web page" : ""}. ${LINK_HELP}`);
  }
  const html = decodePage(bytes, contentType, found.text);

  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());

  const rawTitle =
    doc.querySelector("title")?.textContent?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    undefined;
  const title = rawTitle ? cutTitle(rawTitle) : undefined;

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
  if (new TextEncoder().encode(text).length > MAX_TEXT_FILE_BYTES) throw new Error(PAGE_TEXT_TOO_LARGE_MESSAGE);

  return { text, title, meta: { url } };
}
