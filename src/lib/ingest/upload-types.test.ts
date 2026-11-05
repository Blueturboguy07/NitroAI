/* D1 (blind verify of 89b3aa4): every upload that was not .pdf/.doc/.docx was
   read as text. A dropped 120 KB .pptx became 8 paid calls and a note of
   garbage; a 5 MB deck would be about 210 calls. Only .txt and .md are text,
   a "text" file with binary data or over 2 MB is refused, and every refusal
   happens before any model call. */
import { describe, expect, it } from "vitest";
import { ingest } from "./index";
import { createNoteFromSources } from "../generation/pipeline";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Engine } from "../engine/types";

const EXACT =
  "NitroAI reads PDF, Word (.docx), .txt and .md files. For slides, save them as PDF and upload that.";
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/* A .pptx is a zip: "PK\x03\x04", then binary data with NUL bytes. */
function fakePptx(size = 120 * 1024): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
  for (let i = 8; i < size; i++) b[i] = (i * 31) % 256;
  // A local file header whose part name is ppt/slides/slide1.xml (name length at +26).
  const name = new TextEncoder().encode("ppt/slides/slide1.xml");
  b[26] = name.length;
  b[27] = 0;
  b[28] = 0;
  b[29] = 0;
  b.set(name, 30);
  return b;
}

const upload = (parts: BlobPart[], name: string) =>
  ingest({ kind: "text", file: new File(parts, name), filename: name });

/* Counts every call; a refused upload must leave it at 0. */
function countingEngine() {
  const n = { calls: 0 };
  const engine: Engine = {
    mode: "cloud",
    capabilities: () => ({ chat: true, transcription: true, tts: true, embeddings: true }),
    complete: async (_o, onToken) => {
      n.calls++;
      onToken?.("# Notes\n\nText.");
      return "# Notes\n\nText.";
    },
    structured: async () => {
      n.calls++;
      return {} as never;
    },
    transcribe: async () => {
      n.calls++;
      return { text: "t", segments: [] };
    },
    tts: async () => new Blob(),
    embed: async () => {
      n.calls++;
      return [];
    },
    validate: async () => {},
  };
  return { engine, n };
}

describe("D1 — which uploads are read", () => {
  it("a .pptx sent as kind text is refused with the message, not read as text", async () => {
    await expect(upload([fakePptx()], "Week 5 slides.pptx")).rejects.toThrow(EXACT);
    await expect(upload([fakePptx()], "Week 5 slides.pptx")).rejects.toThrow(/Week 5 slides\.pptx/);
  });

  it("other names are refused too (.xlsx, .csv, no extension)", async () => {
    for (const name of ["grades.xlsx", "data.csv", "README"]) {
      await expect(upload(["a,b,c\n1,2,3\n"], name)).rejects.toThrow(EXACT);
    }
  });

  it("a .txt with binary data (a NUL byte in the first 8 KB) is refused", async () => {
    // A NUL byte with no known signature: binary data.
    const nul = new Uint8Array(4000).fill(0x61);
    nul[100] = 0;
    await expect(upload([nul], "renamed-deck.txt")).rejects.toThrow(/not plain text/);
    await expect(upload([nul], "renamed-deck.txt")).rejects.toThrow(EXACT);
    // The real .pptx bytes are named for what they are.
    await expect(upload([fakePptx()], "renamed-deck.txt")).rejects.toThrow(/"renamed-deck.txt" is a PowerPoint file, not a text file/);
  });

  it("a NUL byte after the first 8 KB does not count", async () => {
    const b = new Uint8Array(9000).fill(0x61);
    b[8500] = 0;
    await expect(upload([b], "late-nul.md")).resolves.toMatchObject({ title: "late-nul" });
  });

  it("a UTF-16 file (BOM, so NUL bytes are normal) is still read", async () => {
    const s = "Stomata";
    const bytes = new Uint8Array(2 + s.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) bytes[2 + i * 2] = s.charCodeAt(i);
    expect((await upload([bytes], "utf16.txt")).text).toBe(s);
  });

  it("a .txt over 2 MB is refused with a message in words", async () => {
    const big = new Uint8Array(MAX_TEXT_FILE_BYTES + 1).fill(0x61);
    await expect(upload([big], "huge.txt")).rejects.toThrow(/huge\.txt" is 2\.01 MB\. NitroAI reads \.txt and \.md files up to 2 MB/);
  });

  it("a .txt of exactly 2 MB is read", async () => {
    const ok = new Uint8Array(MAX_TEXT_FILE_BYTES).fill(0x61);
    expect((await upload([ok], "max.txt")).text.length).toBe(MAX_TEXT_FILE_BYTES);
  });

  it("a .pptx in the pipeline makes 0 model calls and the job says why", async () => {
    const repo = new Repo(memoryStore());
    const { engine, n } = countingEngine();
    let lastError: string | undefined;
    await expect(
      createNoteFromSources({
        repo,
        engine,
        inputs: [{ kind: "text", file: new File([fakePptx()], "deck.pptx"), filename: "deck.pptx" }],
        onProgress: (j) => (lastError = j.error),
      }),
    ).rejects.toThrow(EXACT);
    expect(n.calls).toBe(0);
    expect(lastError).toContain(EXACT);
    expect(await repo.listNotes()).toHaveLength(0);
  });
});
