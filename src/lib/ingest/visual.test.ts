import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentPart, Engine, EngineCapabilities } from "../engine/types";
import { EngineError } from "../engine/types";
import { SourceError, type IngestInput, type IngestResult } from "./index";
import { completeSparseDocument, needsVisualRead, MAX_VISUAL_PAGES } from "./visual";

/* Page rendering and DOCX image extraction need a real browser / a real
   .docx; the fallback logic around them is what's under test here. */
vi.mock("./pdf", async (orig) => ({
  ...(await orig<typeof import("./pdf")>()),
  renderPdfPages: vi.fn(),
}));
vi.mock("./docx", async (orig) => ({
  ...(await orig<typeof import("./docx")>()),
  extractDocxImages: vi.fn(),
}));
import { renderPdfPages } from "./pdf";
import { extractDocxImages } from "./docx";

const jpeg = (n: number) => Array.from({ length: n }, (_, i) => new Blob([`page${i}`], { type: "image/jpeg" }));

function engine(caps: Partial<EngineCapabilities>, read?: (parts: DocumentPart[]) => Promise<string>): Engine & { reads: DocumentPart[][] } {
  const reads: DocumentPart[][] = [];
  return {
    mode: "cloud",
    reads,
    capabilities: () => ({ chat: true, transcription: false, tts: false, embeddings: false, ...caps }),
    complete: async () => "",
    structured: async () => ({}) as never,
    transcribe: async () => ({ text: "", segments: [] }),
    tts: async () => new Blob(),
    embed: async () => [],
    validate: async () => {},
    ...(read && {
      readDocument: async (parts: DocumentPart[]) => {
        reads.push(parts);
        return read(parts);
      },
    }),
  };
}

const pdfInput: IngestInput = { kind: "pdf", file: new Blob(["%PDF"], { type: "application/pdf" }), filename: "slides.pdf" };
const scanned = (pages: number, text = ""): IngestResult => ({ text, meta: { pages, textPages: 0 } });

beforeEach(() => {
  vi.mocked(renderPdfPages).mockReset();
  vi.mocked(extractDocxImages).mockReset();
});

describe("needsVisualRead", () => {
  it("flags PDFs whose pages mostly have no text layer", () => {
    expect(needsVisualRead(pdfInput, scanned(12))).toBe(true);
    expect(needsVisualRead(pdfInput, { text: "1 2 3", meta: { pages: 3, textPages: 0 } })).toBe(true);
    const real = "Mitochondria are the powerhouse of the cell. ".repeat(10);
    expect(needsVisualRead(pdfInput, { text: real, meta: { pages: 2, textPages: 2 } })).toBe(false);
  });

  it("flags DOCX with next to no text, and never other kinds", () => {
    const docx: IngestInput = { kind: "docx", file: new Blob(["x"]), filename: "a.docx" };
    expect(needsVisualRead(docx, { text: "Week 3" })).toBe(true);
    expect(needsVisualRead({ kind: "text", file: new Blob([""]) }, { text: "" })).toBe(false);
    expect(needsVisualRead({ kind: "url", url: "https://x" }, { text: "" })).toBe(false);
  });
});

describe("completeSparseDocument — PDF", () => {
  it("sends a short PDF whole to an engine that reads PDFs natively", async () => {
    const e = engine({ vision: true, visionPdf: true }, async () => "Slide 1: Cell division");
    const onReading = vi.fn();
    const text = await completeSparseDocument(e, pdfInput, scanned(10), { onReading });
    expect(text).toBe("Slide 1: Cell division");
    expect(e.reads).toHaveLength(1);
    expect(e.reads[0][0].mimeType).toBe("application/pdf");
    expect(onReading).toHaveBeenCalledOnce();
    expect(renderPdfPages).not.toHaveBeenCalled();
  });

  it("renders pages and reads them in batches for image-only engines", async () => {
    vi.mocked(renderPdfPages).mockResolvedValue({ images: jpeg(14), total: 14 });
    const e = engine({ vision: true }, async (parts) => `read ${parts.length}`);
    const text = await completeSparseDocument(e, pdfInput, scanned(14));
    expect(renderPdfPages).toHaveBeenCalledWith(pdfInput.file, expect.objectContaining({ maxPages: MAX_VISUAL_PAGES }));
    expect(e.reads.map((r) => r.length)).toEqual([6, 6, 2]);
    expect(e.reads[0][0].mimeType).toBe("image/jpeg");
    expect(text).toBe("read 6\n\nread 6\n\nread 2");
  });

  it("renders a long PDF even when the engine reads PDFs natively", async () => {
    vi.mocked(renderPdfPages).mockResolvedValue({ images: jpeg(2), total: 80 });
    const e = engine({ vision: true, visionPdf: true }, async () => "text");
    await completeSparseDocument(e, pdfInput, scanned(80));
    expect(renderPdfPages).toHaveBeenCalled();
    expect(e.reads[0][0].mimeType).toBe("image/jpeg");
  });

  it("explains the scanned PDF and points to Settings when the engine can't read images", async () => {
    const e = engine({ vision: false });
    const err = await completeSparseDocument(e, pdfInput, scanned(5)).catch((x) => x);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.fix).toBe("settings");
    expect(err.message).toMatch(/no selectable text — it looks like scanned pages/);
    expect(err.message).toMatch(/Gemini, OpenAI or Anthropic key/);
  });

  it("keeps thin-but-real extracted text when the engine can't read images", async () => {
    const some = "A real paragraph of lecture text that is long enough to write notes from. ".repeat(2);
    const e = engine({ vision: false });
    await expect(completeSparseDocument(e, pdfInput, { text: some, meta: { pages: 10, textPages: 1 } })).resolves.toBe(some);
  });

  it("falls back to extracted text, or explains, when the visual read fails", async () => {
    const failing = engine({ vision: true, visionPdf: true }, async () => {
      throw new EngineError("image input not supported by this model", "unknown");
    });
    const some = "Enough real text extracted from the few pages with a text layer to be useful. ".repeat(2);
    await expect(completeSparseDocument(failing, pdfInput, { text: some, meta: { pages: 10, textPages: 1 } })).resolves.toBe(some);

    const err = await completeSparseDocument(failing, pdfInput, scanned(3)).catch((x) => x);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe(
      "This PDF looks like scanned pages, and reading them as images failed: image input not supported by this model",
    );
  });

  it("says the PDF is blank when even the visual read finds nothing", async () => {
    const e = engine({ vision: true, visionPdf: true }, async () => "");
    await expect(completeSparseDocument(e, pdfInput, scanned(2))).rejects.toThrow(/not even reading its pages as images/);
  });
});

describe("completeSparseDocument — DOCX", () => {
  const docx: IngestInput = { kind: "docx", file: new Blob(["PK"]), filename: "screens.docx" };

  it("reads embedded images and keeps the little text there was", async () => {
    vi.mocked(extractDocxImages).mockResolvedValue({ images: [new Blob(["i"], { type: "image/png" })], skipped: 0 });
    const e = engine({ vision: true }, async () => "Text from the screenshot");
    await expect(completeSparseDocument(e, docx, { text: "Week 3" })).resolves.toBe("Week 3\n\nText from the screenshot");
    expect(e.reads[0][0].mimeType).toBe("image/png");
  });

  it("calls an empty document empty, and an images-only one unreadable without vision", async () => {
    vi.mocked(extractDocxImages).mockResolvedValue({ images: [], skipped: 0 });
    await expect(completeSparseDocument(engine({ vision: true }, async () => ""), docx, { text: "" })).rejects.toThrow(
      "This document is empty — there's no text in it.",
    );

    vi.mocked(extractDocxImages).mockResolvedValue({ images: [], skipped: 2 });
    await expect(completeSparseDocument(engine({}), docx, { text: "" })).rejects.toThrow(/drawings in a format/);

    vi.mocked(extractDocxImages).mockResolvedValue({ images: [new Blob(["i"], { type: "image/png" })], skipped: 0 });
    const err = await completeSparseDocument(engine({}), docx, { text: "" }).catch((x) => x);
    expect(err.message).toMatch(/^This document has no text, only images\./);
    expect(err.fix).toBe("settings");
  });
});
