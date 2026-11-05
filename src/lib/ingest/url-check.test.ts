// @vitest-environment jsdom
/* Round 4, item 2: the Website-link reader had no binary check (a link to a
   PNG became paid calls) and no size limit. It now uses the shared check and
   the 2 MB text limit. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingest } from "./index";
import { createNoteFromSources } from "../generation/pipeline";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Engine } from "../engine/types";

afterEach(() => vi.unstubAllGlobals());

function serve(body: Uint8Array | string, type: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(typeof body === "string" ? body : body.slice(), { status: 200, headers: { "content-type": type } })),
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
    await expect(ingest({ kind: "url", url: "https://example.com/huge" })).rejects.toThrow(/more than 2 MB of text/);
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
