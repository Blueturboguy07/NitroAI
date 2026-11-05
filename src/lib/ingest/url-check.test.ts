// @vitest-environment jsdom
/* Round 4, item 2: the Website-link reader had no binary check (a link to a
   PNG became paid calls) and no size limit. It now uses the shared check and
   the 2 MB text limit.
   Round 5, item 3: the renderer's own fetch() failed with "Failed to fetch"
   (CORS) on most real sites. The page now comes from the app's local server
   (GET /api/fetch-page, server/fetchPage.mjs); `serve` stands in for it.
   Round 6: `serve` answers 403 (as the server's guard does) when the call
   has no x-nitroai-app header; "hello world" is not a link; a link to this
   computer is refused in words. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingest } from "./index";
import { createNoteFromSources } from "../generation/pipeline";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Engine } from "../engine/types";

afterEach(() => vi.unstubAllGlobals());

/* The local server's route answers; a direct fetch of a site fails as CORS
   makes it fail in the app. */
function serve(body: Uint8Array | string, type: string) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(String(input));
      if (!String(input).startsWith("/api/fetch-page?url=")) throw new TypeError("Failed to fetch");
      // The guard in front of every /api/* route (server/localGuard.mjs).
      if (new Headers(init?.headers).get("x-nitroai-app") !== "1") {
        return new Response(JSON.stringify({ error: "forbidden", reason: "app header" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body.slice();
      return new Response(bytes, { status: 200, headers: { "x-nitroai-page": "1", "x-nitroai-content-type": type, "content-type": "application/octet-stream" } });
    }),
  );
  return calls;
}
function serveError(status: number, body: object) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "x-nitroai-page": "1", "content-type": "application/json" } })),
  );
}
const png = () => {
  const b = new Uint8Array(40_000);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  for (let i = 16; i < b.length; i++) b[i] = (i * 73) % 251 || 0x41;
  return b;
};

describe("Website link — the shared check", () => {
  it("a link to a PNG is refused in words", async () => {
    serve(png(), "image/png");
    await expect(ingest({ kind: "url", url: "https://example.com/diagram.png" })).rejects.toThrow(
      "That link is an image, not a web page. Paste a link to a web page or a YouTube video.",
    );
  });

  it("a link to a PNG makes 0 model calls", async () => {
    serve(png(), "image/png");
    const n = { calls: 0 };
    const engine: Engine = {
      mode: "cloud",
      capabilities: () => ({ chat: true, transcription: true, tts: true, embeddings: true }),
      complete: async () => (n.calls++, "# x"),
      structured: async () => (n.calls++, {} as never),
      transcribe: async () => (n.calls++, { text: "", segments: [] }),
      tts: async () => new Blob(),
      embed: async () => [],
      validate: async () => {},
    };
    await expect(createNoteFromSources({ repo: new Repo(memoryStore()), engine, inputs: [{ kind: "url", url: "https://example.com/diagram.png" }] })).rejects.toThrow(/an image/);
    expect(n.calls).toBe(0);
  });

  it("a link to a PDF says to upload it as a PDF", async () => {
    serve(new TextEncoder().encode("%PDF-1.7\n" + "1 0 obj << >> endobj\n".repeat(50)), "application/pdf");
    await expect(ingest({ kind: "url", url: "https://example.com/syllabus.pdf" })).rejects.toThrow(/That link is a PDF file, not a web page\. Download it, then add it with "Document upload"\./);
  });

  it("a page with more than 2 MB of text is refused", async () => {
    serve(`<html><body><p>${"Calvin cycle. ".repeat(160_000)}</p></body></html>`, "text/html; charset=utf-8");
    await expect(ingest({ kind: "url", url: "https://example.com/huge" })).rejects.toThrow(
      "That page has more than 2 MB of text, and NitroAI reads up to 2 MB. Save the part you need as a .txt or PDF file and upload that.",
    );
  });

  it("a normal page still reads, with its title cut at a word", async () => {
    serve(
      `<html><head><title>The Calvin cycle: how plants fix carbon dioxide into sugar in the stroma of every chloroplast</title></head><body><h1>Calvin cycle</h1><p>RuBisCO fixes CO2.</p></body></html>`,
      "text/html; charset=utf-8",
    );
    const res = await ingest({ kind: "url", url: "https://example.com/calvin" });
    expect(res.text).toContain("RuBisCO fixes CO2.");
    expect(res.title!.length).toBeLessThanOrEqual(80);
    const full = "The Calvin cycle: how plants fix carbon dioxide into sugar in the stroma of every chloroplast";
    expect(full.startsWith(res.title!)).toBe(true);
    expect(full[res.title!.length]).toBe(" ");
  });
});

describe("Website link — downloaded by the local server (round 5)", () => {
  const ARTICLE = `<html><head><title>Photosynthesis - Wikipedia</title></head><body><p>Photosynthesis is how plants make sugar.</p></body></html>`;

  it("the page comes from /api/fetch-page, not from the renderer's own fetch (which CORS blocks)", async () => {
    const calls = serve(ARTICLE, "text/html; charset=UTF-8");
    const res = await ingest({ kind: "url", url: "https://en.wikipedia.org/wiki/Photosynthesis" });
    expect(res.text).toContain("Photosynthesis is how plants make sugar.");
    expect(calls).toEqual([`/api/fetch-page?url=${encodeURIComponent("https://en.wikipedia.org/wiki/Photosynthesis")}`]);
  });

  it("only http and https links are read, with 0 downloads", async () => {
    const calls = serve(ARTICLE, "text/html");
    for (const url of ["file:///etc/passwd", "ftp://example.com/notes.txt", "javascript:alert(1)"]) {
      await expect(ingest({ kind: "url", url }), url).rejects.toThrow("NitroAI reads http and https links only. Paste a link to a web page or a YouTube video.");
    }
    expect(calls).toHaveLength(0);
  });

  it("a link with no scheme means https", async () => {
    const calls = serve(ARTICLE, "text/html");
    await ingest({ kind: "url", url: "en.wikipedia.org/wiki/Photosynthesis" });
    expect(calls[0]).toBe(`/api/fetch-page?url=${encodeURIComponent("https://en.wikipedia.org/wiki/Photosynthesis")}`);
  });

  it("D1 (round 8): the note keeps the https:// link, not the bare text that was pasted", async () => {
    serve(ARTICLE, "text/html");
    const res = await ingest({ kind: "url", url: " en.wikipedia.org/wiki/Photosynthesis " });
    expect(res.meta?.url).toBe("https://en.wikipedia.org/wiki/Photosynthesis");
  });

  it("a page over the 8 MB download cap says 8 MB, not 2 MB", async () => {
    serveError(413, { error: "too_large", limit: 8 * 1024 * 1024 });
    const err = (await ingest({ kind: "url", url: "https://example.com/huge.html" }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("That page is more than 8 MB to download, and NitroAI downloads up to 8 MB from a link. Save the part you need as a .txt or PDF file and upload that.");
  });

  it("the site's error and an unreachable site are said in words", async () => {
    serveError(502, { error: "status", status: 404 });
    await expect(ingest({ kind: "url", url: "https://example.com/gone" })).rejects.toThrow('Couldn\'t fetch "https://example.com/gone" (server responded with 404). Check the URL and your connection.');
    serveError(502, { error: "network", reason: "the site was not found" });
    await expect(ingest({ kind: "url", url: "https://no-such-site.example/" })).rejects.toThrow("(the site was not found)");
    serveError(504, { error: "timeout" });
    await expect(ingest({ kind: "url", url: "https://slow.example/" })).rejects.toThrow("(the site took too long to answer)");
  });

  it('"hello world" and other text with a space or no dot is "not a link", with 0 downloads (it became https://hello%20world/)', async () => {
    const calls = serve(ARTICLE, "text/html");
    for (const text of ["hello world", "  hello world  ", "notes", "photosynthesis", "en.wikipedia.org/wiki/Photo synthesis"]) {
      await expect(ingest({ kind: "url", url: text }), text).rejects.toThrow(`"${text}" is not a link. Paste a link to a web page or a YouTube video.`);
    }
    expect(calls).toHaveLength(0);
  });

  it("a link to this computer is refused in words before any download; the server's 'blocked' answer is said the same way", async () => {
    const BLOCKED = "That link points to this computer or to a private network. NitroAI reads public web pages only. Paste a link to a web page or a YouTube video.";
    const calls = serve(ARTICLE, "text/html");
    for (const url of ["http://localhost:41763/api/publik/status", "localhost/x", "http://app.localhost/"]) {
      await expect(ingest({ kind: "url", url }), url).rejects.toThrow(BLOCKED);
    }
    expect(calls).toHaveLength(0);
    serveError(403, { error: "blocked", reason: "the link points to this computer or a private network" });
    await expect(ingest({ kind: "url", url: "http://169.254.169.254/latest/meta-data/" })).rejects.toThrow(BLOCKED);
  });

  it("an IPv6 or IPv4 address link still goes to the local server (which checks it)", async () => {
    const calls = serve(ARTICLE, "text/html");
    await ingest({ kind: "url", url: "http://[2606:4700::1111]/" });
    await ingest({ kind: "url", url: "93.184.215.14/page" });
    expect(calls).toEqual([
      `/api/fetch-page?url=${encodeURIComponent("http://[2606:4700::1111]/")}`,
      `/api/fetch-page?url=${encodeURIComponent("https://93.184.215.14/page")}`,
    ]);
  });

  it("a host without the route (the web build) fetches the page itself, as before", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(String(input));
        if (String(input).startsWith("/api/")) return new Response("<html>app</html>", { status: 200, headers: { "content-type": "text/html" } });
        return new Response(ARTICLE, { status: 200, headers: { "content-type": "text/html" } });
      }),
    );
    const res = await ingest({ kind: "url", url: "https://example.com/a" });
    expect(res.text).toContain("Photosynthesis is how plants make sugar.");
    expect(calls).toEqual([`/api/fetch-page?url=${encodeURIComponent("https://example.com/a")}`, "https://example.com/a"]);
  });
});
