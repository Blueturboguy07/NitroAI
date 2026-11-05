/* A link typed without a scheme means https: "youtu.be/jNQXAC9IVRw",
   "en.wikipedia.org/wiki/X". Round 8 (D1): a bare youtu.be link was found
   to be YouTube but was sent without "https://", and the local server
   refused it as "not a link". Both the YouTube path and the Website path
   use this. Text that already has a scheme ("http:", "javascript:") is
   returned as typed (trimmed), so the scheme checks still see it. */
export function withScheme(text: string): string {
  const t = text.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
}
