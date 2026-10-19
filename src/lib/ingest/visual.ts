/* Visual (OCR) fallback for documents whose text layer is empty or nearly so
   — scanned PDFs, lecture slides exported as images, Word files made of
   pasted screenshots. Text extraction (./pdf, ./docx) finds nothing there, so
   the engine reads the pages themselves through Engine.readDocument(). When
   the engine can't, the user gets a message that says what to change. */

import type { DocumentPart, Engine } from "../engine/types";
import { EngineError } from "../engine/types";
import { supportsTask, unsupportedMessage } from "../engine/router";
import { SourceError, type IngestInput, type IngestResult } from "./index";
import { MIN_PAGE_CHARS, renderPdfPages } from "./pdf";
import { extractDocxImages } from "./docx";

/* Less text than this isn't worth writing notes from on its own (a title
   slide, page numbers), so it never stands in for a failed visual read. */
export const MIN_USABLE_CHARS = 100;

/* Engines that take PDFs natively get the whole file up to this size and
   length; anything bigger is rendered and sent a few pages per call. */
const NATIVE_PDF_MAX_BYTES = 10 * 1024 * 1024;
const NATIVE_PDF_MAX_PAGES = 30;
/* Upper bound on pages/images read visually per document (cost + time). */
export const MAX_VISUAL_PAGES = 40;
const PAGES_PER_CALL = 6;

function charCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function hasUsableText(text: string): boolean {
  return charCount(text) >= MIN_USABLE_CHARS;
}

/* Whether a PDF/DOCX's extracted text is too thin to be the whole document:
   most PDF pages have no text layer, or there's barely any text per page. */
export function needsVisualRead(input: IngestInput, res: IngestResult): boolean {
  if (!input.file) return false;
  const chars = charCount(res.text);
  if (input.kind === "pdf") {
    const pages = Number(res.meta?.pages) || 0;
    if (pages === 0) return false;
    const textPages = Number(res.meta?.textPages ?? pages);
    return textPages < pages / 2 || chars < pages * MIN_PAGE_CHARS;
  }
  if (input.kind === "docx") return chars < MIN_USABLE_CHARS;
  return false;
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

async function readInBatches(engine: Engine, parts: DocumentPart[], signal?: AbortSignal): Promise<string> {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += PAGES_PER_CALL) {
    signal?.throwIfAborted();
    const text = await engine.readDocument!(parts.slice(i, i + PAGES_PER_CALL), signal);
    if (text.trim()) out.push(text.trim());
  }
  return out.join("\n\n");
}

async function readPdf(engine: Engine, file: Blob, pages: number, signal?: AbortSignal): Promise<string> {
  if (engine.capabilities().visionPdf && file.size <= NATIVE_PDF_MAX_BYTES && pages <= NATIVE_PDF_MAX_PAGES) {
    return engine.readDocument!([{ mimeType: "application/pdf", data: file }], signal);
  }
  const { images } = await renderPdfPages(file, { maxPages: MAX_VISUAL_PAGES, signal });
  return readInBatches(engine, images.map((data) => ({ mimeType: data.type || "image/jpeg", data })), signal);
}

/* Complete a PDF/DOCX whose text came back empty or thin (see
   needsVisualRead). Returns the best text available — the visual read when
   it found more, else what extraction had — or throws a SourceError /
   EngineError that says what to do. `onReading` fires right before the
   (slow, paid) engine call so the job can say so. */
export async function completeSparseDocument(
  engine: Engine,
  input: IngestInput,
  res: IngestResult,
  opts: { signal?: AbortSignal; onReading?: () => void | Promise<void> } = {},
): Promise<string> {
  const file = input.file!;
  const extracted = res.text;
  const what = input.kind === "pdf" ? "This PDF" : "This document";
  const canRead = supportsTask(engine, "vision");

  let docxImages: DocumentPart[] = [];
  if (input.kind === "docx") {
    const { images, skipped } = await extractDocxImages(file, MAX_VISUAL_PAGES);
    docxImages = images.map((data) => ({ mimeType: data.type, data }));
    if (docxImages.length === 0) {
      if (extracted.trim()) return extracted;
      throw new SourceError(
        skipped > 0
          ? "This document has no text, only drawings in a format NitroAI can't read. Save it as a PDF and upload that instead."
          : "This document is empty — there's no text in it.",
      );
    }
  }

  if (!canRead) {
    if (hasUsableText(extracted)) return extracted;
    const looks =
      input.kind === "pdf"
        ? "This PDF has no selectable text — it looks like scanned pages or slides saved as images."
        : "This document has no text, only images.";
    throw new SourceError(
      `${looks} ${unsupportedMessage("vision", engine.provider)}` +
        (input.kind === "pdf" ? " Or run it through an OCR tool (e.g. Acrobat's “Recognize Text”) and upload that copy." : ""),
      "settings",
    );
  }

  let visual: string;
  try {
    await opts.onReading?.();
    visual =
      input.kind === "pdf"
        ? await readPdf(engine, file, Number(res.meta?.pages) || 0, opts.signal)
        : await readInBatches(engine, docxImages, opts.signal);
  } catch (e) {
    if (isAbort(e)) throw e;
    if (hasUsableText(extracted)) return extracted;
    const reason = e instanceof Error ? e.message : String(e);
    const message = `${what} looks like scanned pages, and reading them as images failed: ${reason}`;
    throw e instanceof EngineError ? new EngineError(message, e.kind, e.detail) : new Error(message);
  }

  if (input.kind === "docx") {
    const text = [extracted.trim(), visual.trim()].filter(Boolean).join("\n\n");
    if (text) return text;
    throw new SourceError("This document's images have no readable text in them.");
  }
  if (charCount(visual) > charCount(extracted)) return visual.trim();
  if (extracted.trim()) return extracted;
  throw new SourceError("This PDF has no text NitroAI could find — not even reading its pages as images. Is it blank?");
}
