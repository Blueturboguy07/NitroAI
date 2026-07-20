import type { IngestResult } from "./index";

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    /* Allow bare "youtube.com/..." (no scheme). */
    try {
      return new URL(`https://${url}`);
    } catch {
      return null;
    }
  }
}

/* Extract the 11-char video id from watch?v=, youtu.be/, /embed/, /shorts/
   (and /live/) forms. Pure — no network. */
export function youtubeId(url: string): string | null {
  const u = parse(url);
  if (!u) return null;

  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");

  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0] ?? "";
    return ID_RE.test(id) ? id : null;
  }

  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      return id && ID_RE.test(id) ? id : null;
    }
    const match = u.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  return null;
}

export function isYoutube(url: string): boolean {
  return youtubeId(url) !== null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseTimedText(xml: string): string | null {
  const matches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  if (matches.length === 0) return null;
  const lines = matches
    .map((m) => decodeEntities(m[1] ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.length ? lines.join(" ") : null;
}

async function fetchTranscript(id: string): Promise<string | null> {
  for (const lang of ["en", "en-US", "en-GB"]) {
    const res = await fetch(
      `https://www.youtube.com/api/timedtext?lang=${lang}&v=${id}`,
    );
    if (!res.ok) continue;
    const xml = await res.text();
    const text = xml.trim() ? parseTimedText(xml) : null;
    if (text) return text;
  }
  return null;
}

async function fetchTitle(id: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${id}`);
    if (!res.ok) return undefined;
    const html = await res.text();
    const match = html.match(/<title>([^<]*)<\/title>/);
    if (!match) return undefined;
    return decodeEntities(match[1] ?? "").replace(/\s*-\s*YouTube\s*$/, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface YtExtract {
  transcript?: string | null;
  audioBase64?: string | null;
  audioExt?: string | null;
  title?: string | null;
}

function base64ToBlob(b64: string, ext: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = ext === "mp3" ? "audio/mpeg" : ext === "wav" ? "audio/wav" : "audio/mp4";
  return new Blob([bytes], { type });
}

function resultFromExtract(r: YtExtract, url: string): IngestResult | null {
  const title = r.title || undefined;
  if (r.transcript && r.transcript.trim()) {
    return { text: r.transcript, title, meta: { url } };
  }
  if (r.audioBase64) {
    const audio = base64ToBlob(r.audioBase64, r.audioExt || "m4a");
    return {
      text: "",
      title,
      needsTranscription: true,
      audio,
      meta: { url, filename: `${title ?? "youtube"}.${r.audioExt || "m4a"}` },
    };
  }
  return null;
}

/* Desktop path: the Rust `youtube_extract` command runs yt-dlp — captions first,
   then audio extraction as a fallback — which is the only reliable free method
   in 2026 (YouTube's PoToken gate blocks browser-side caption fetches). */
async function ingestYoutubeDesktop(url: string): Promise<IngestResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const r = await invoke<YtExtract>("youtube_extract", { url });
  const result = resultFromExtract(r, url);
  if (result) return result;
  throw new Error(
    "yt-dlp couldn't get captions or audio for this video. Make sure yt-dlp is installed.",
  );
}

/* Browser path, step 1: the vite dev/preview server ships the same yt-dlp
   extraction as the desktop app behind /api/youtube-extract (see
   vite.youtube-plugin.ts). Returns null only when the helper isn't there at
   all — i.e. a purely static deployment. */
async function ingestViaLocalServer(url: string): Promise<IngestResult | null> {
  let res: Response;
  try {
    res = await fetch(`/api/youtube-extract?url=${encodeURIComponent(url)}`);
  } catch {
    return null;
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) return null; // SPA fallback answered — no helper on this host
  const body = (await res.json()) as YtExtract & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || "YouTube extraction failed on the local server.");
  }
  return resultFromExtract(body, url);
}

/* YouTube ingestion. On the desktop app this runs yt-dlp (captions → audio →
   Whisper). In a plain browser, YouTube's 2026 bot-gating makes caption fetches
   return empty, so after a best-effort attempt we fail with an honest, actionable
   message rather than silently producing nothing. */
export async function ingestYoutube(url: string): Promise<IngestResult> {
  const id = youtubeId(url);
  if (!id) {
    throw new Error(`"${url}" doesn't look like a YouTube URL.`);
  }

  if (inTauri()) {
    return ingestYoutubeDesktop(url);
  }

  if (typeof fetch === "undefined") {
    throw new Error("Network access is unavailable in this environment.");
  }

  const viaServer = await ingestViaLocalServer(url);
  if (viaServer) return viaServer;

  let transcript: string | null = null;
  try {
    transcript = await fetchTranscript(id);
  } catch {
    transcript = null;
  }

  if (transcript) {
    const title = await fetchTitle(id);
    return { text: transcript, title, meta: { url, videoId: id } };
  }

  throw new Error(
    "This deployment can't reach YouTube (its bot-protection blocks transcript fetches from a static site). " +
      "Use the NitroAI desktop app or run the app locally (`npm run preview`) — both extract captions/audio " +
      "automatically — or download the audio and drop it into “Record or upload audio”.",
  );
}
