/* Unreadable sources in the note pipeline: scanned PDFs read visually when the
   engine can, and every failure names the file and says what to do (this
   used to be a bare "No readable content found."). */
import { describe, expect, it, vi } from "vitest";
import type { DocumentPart, Engine, EngineCapabilities } from "../engine/types";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Job } from "../types";
import { createNoteFromSources, partialFailureMessage, SourcesUnreadableError } from "./pipeline";

/* pdf.js can't run under Node: stand in for text extraction of a 4-page
   scanned PDF (no text layer on any page). */
vi.mock("../ingest/pdf", async (orig) => ({
  ...(await orig<typeof import("../ingest/pdf")>()),
  ingestPdf: vi.fn(async () => ({ text: "", meta: { filename: "slides.pdf", pages: 4, textPages: 0 } })),
  renderPdfPages: vi.fn(async () => ({
    images: [1, 2, 3, 4].map((i) => new Blob([`p${i}`], { type: "image/jpeg" })),
    total: 4,
  })),
}));

const NOTE_MD = "# Cell Division\n\nMitosis has four phases.";

function fakeEngine(caps: Partial<EngineCapabilities>, read?: (parts: DocumentPart[]) => Promise<string>) {
  const seen: { reads: DocumentPart[][]; prompts: string[] } = { reads: [], prompts: [] };
  const engine: Engine = {
    mode: "cloud",
    capabilities: () => ({ chat: true, transcription: true, tts: false, embeddings: false, ...caps }),
    complete: async (opts) => {
      seen.prompts.push(opts.messages.at(-1)!.content);
      return (opts.maxTokens ?? 999) <= 40 ? "Cell Division" : NOTE_MD;
    },
    structured: async () => ({}) as never,
    transcribe: async () => ({ text: "", segments: [] }),
    tts: async () => new Blob(),
    embed: async () => [],
    validate: async () => {},
    ...(read && {
      readDocument: async (parts: DocumentPart[]) => {
        seen.reads.push(parts);
        return read(parts);
      },
    }),
  };
  return { engine, seen };
}

const scannedPdf = { kind: "pdf" as const, file: new Blob(["%PDF"], { type: "application/pdf" }), filename: "slides.pdf" };

describe("scanned PDFs", () => {
  it("are read visually by an engine that can, and the note is written from that text", async () => {
    const repo = new Repo(memoryStore());
    const { engine, seen } = fakeEngine({ vision: true, visionPdf: true }, async () => "Mitosis: prophase, metaphase");
    const messages: string[] = [];
    const id = await createNoteFromSources({ repo, engine, inputs: [scannedPdf], onProgress: (j) => messages.push(j.message) });

    const note = await repo.getNote(id);
    expect(note!.sourceText).toBe("Mitosis: prophase, metaphase");
    expect(note!.blocks.length).toBeGreaterThan(0);
    expect(seen.reads).toHaveLength(1);
    expect(seen.reads[0][0].mimeType).toBe("application/pdf");
    expect(seen.prompts.some((p) => p.includes("Mitosis: prophase"))).toBe(true);
    expect(messages).toContain("Reading the pages of slides.pdf…");
  });

  it("are rendered to page images for an engine that reads images but not PDFs", async () => {
    const repo = new Repo(memoryStore());
    const { engine, seen } = fakeEngine({ vision: true }, async (parts) => `${parts.length} pages of text`);
    const id = await createNoteFromSources({ repo, engine, inputs: [scannedPdf] });
    expect((await repo.getNote(id))!.sourceText).toBe("4 pages of text");
    expect(seen.reads[0].every((p) => p.mimeType === "image/jpeg")).toBe(true);
  });

  it("fail with the file name and a way forward when the engine can't read images", async () => {
    const repo = new Repo(memoryStore());
    const { engine } = fakeEngine({ vision: false });
    const jobs: Job[] = [];
    const err = await createNoteFromSources({ repo, engine, inputs: [scannedPdf], onProgress: (j) => jobs.push({ ...j }) }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(SourcesUnreadableError);
    expect(err.message).toMatch(/^Couldn't read “slides\.pdf”\. This PDF has no selectable text/);
    expect(err.message).toMatch(/Add a Gemini, OpenAI or Anthropic key in Settings/);
    expect(err.message).not.toContain("No readable content found");
    expect(err.fix).toBe("settings");
    expect(jobs.at(-1)!.status).toBe("error");
    expect(jobs.at(-1)!.error).toBe(err.message);
  });
});

describe("empty and failing sources", () => {
  it("name an empty uploaded file", async () => {
    const repo = new Repo(memoryStore());
    const { engine } = fakeEngine({});
    await expect(
      createNoteFromSources({ repo, engine, inputs: [{ kind: "text", file: new Blob(["  \n "]), filename: "notes.md" }] }),
    ).rejects.toThrow("Couldn't read “notes.md”. This file is empty — there's no text in it.");
  });

  it("say what was wrong with pasted text without inventing a name", async () => {
    const repo = new Repo(memoryStore());
    const { engine } = fakeEngine({});
    await expect(createNoteFromSources({ repo, engine, inputs: [{ kind: "text", text: "   " }] })).rejects.toThrow(
      /^There's no text to make notes from/,
    );
  });

  it("list every file when none of several could be read", async () => {
    const repo = new Repo(memoryStore());
    const { engine } = fakeEngine({ vision: false });
    const err = await createNoteFromSources({
      repo,
      engine,
      inputs: [scannedPdf, { kind: "text", file: new Blob([""]), filename: "empty.txt" }],
    }).catch((e) => e);
    expect(err.message).toBe("None of the 2 sources could be read.");
    expect(err.failures.map((f: { name: string }) => f.name)).toEqual(["slides.pdf", "empty.txt"]);
    expect(err.failures[1].error).toMatch(/empty/);
  });

  it("report the files left out when the note was made from the rest", async () => {
    const repo = new Repo(memoryStore());
    const { engine } = fakeEngine({});
    const jobs: Job[] = [];
    await createNoteFromSources({
      repo,
      engine,
      inputs: [
        { kind: "text", text: "Mitosis has four phases." },
        { kind: "text", file: new Blob([""]), filename: "empty.txt" },
      ],
      onProgress: (j) => jobs.push({ ...j, files: j.files?.map((f) => ({ ...f })) }),
    });
    const msg = partialFailureMessage(jobs.at(-1)!.files!);
    expect(msg).toMatch(/^1 of 2 sources couldn't be read/);
    expect(msg).toContain("empty.txt (This file is empty");
    expect(partialFailureMessage([{ name: "a.pdf", status: "done" }])).toBeNull();
  });

  it("stops and marks the job cancelled when the signal aborts", async () => {
    const repo = new Repo(memoryStore());
    const { engine } = fakeEngine({});
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await createNoteFromSources({ repo, engine, inputs: [{ kind: "text", text: "hello" }], signal: ctrl.signal }).catch(
      (e) => e,
    );
    expect(err.name).toBe("AbortError");
    expect(await repo.listNotes()).toEqual([]);
  });

  it("refuse to save a blank note when the model answers with nothing", async () => {
    const repo = new Repo(memoryStore());
    const { engine } = fakeEngine({});
    engine.complete = async () => "";
    await expect(createNoteFromSources({ repo, engine, inputs: [{ kind: "text", text: "Real lecture text." }] })).rejects.toThrow(
      /returned empty notes/,
    );
  });
});
