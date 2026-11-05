/* Which links /api/youtube-extract sends to yt-dlp (round 8, D4).
 *
 * The route is behind the guard (localGuard.mjs), so only the app can call
 * it. Still, yt-dlp can fetch any http(s) link, 127.0.0.1 too. So the
 * server sends only YouTube links: youtube.com and its subdomains (www.,
 * m., music.), youtu.be, and youtube-nocookie.com (and www.), on the
 * default port, with no user name or password. Used by httpServer.mjs and
 * by the dev server plugin (vite.youtube-plugin.ts). Pure Node; no imports. */

export const NOT_A_LINK_MESSAGE = "That is not a link. Paste a YouTube link, for example https://www.youtube.com/watch?v=…";
export const NOT_YOUTUBE_MESSAGE =
  "That is not a YouTube link. NitroAI sends only youtube.com and youtu.be links to yt-dlp. Use \"Website link\" for other pages.";

function youtubeHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h === "youtube.com" ||
    h.endsWith(".youtube.com") ||
    h === "youtu.be" ||
    h === "youtube-nocookie.com" ||
    h === "www.youtube-nocookie.com"
  );
}

/* { url } when `value` is a YouTube link yt-dlp may get; else { error }, a
   message in words. `url` is the parsed link (URL.href), not the typed text,
   so yt-dlp (Python) cannot read another host from it: for example
   "https://www.youtube.com\\@127.0.0.1/" becomes
   "https://www.youtube.com/@127.0.0.1/". */
export function checkYoutubeLink(value) {
  if (typeof value !== "string" || !value.trim()) return { error: NOT_A_LINK_MESSAGE };
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return { error: NOT_A_LINK_MESSAGE };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: NOT_A_LINK_MESSAGE };
  if (u.username || u.password || u.port !== "" || !youtubeHost(u.hostname)) return { error: NOT_YOUTUBE_MESSAGE };
  return { url: u.href };
}
