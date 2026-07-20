import type { IngestResult } from "./index";

/* Element/tag noise that shouldn't leak into extracted body text. */
const STRIP_SELECTOR = "script, style, nav, noscript, iframe, svg, header, footer";

export async function ingestUrl(url: string): Promise<IngestResult> {
  if (typeof DOMParser === "undefined") {
    throw new Error("Fetching web pages is only supported in the browser.");
  }
  if (typeof fetch === "undefined") {
    throw new Error("Network access is unavailable in this environment.");
  }

  let html: string;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`server responded with ${res.status}`);
    }
    html = await res.text();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't fetch "${url}" (${reason}). Check the URL and your connection.`);
  }

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
