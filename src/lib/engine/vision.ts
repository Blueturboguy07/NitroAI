/* Shared bits for Engine.readDocument() — the visual (OCR) fallback for
   documents whose text layer is empty. Each engine wraps the parts in its own
   request shape; the prompt and encoding are the same everywhere so every
   provider hands the note pipeline comparable text. */

import type { DocumentPart } from "./types";
import { EngineError } from "./types";

export const READ_DOCUMENT_PROMPT =
  "These are pages of a document (lecture slides, a scanned handout or similar). " +
  "Transcribe all of the text on them in reading order. Keep headings, bullet points and " +
  "numbering; write tables as Markdown and equations as LaTeX. When a diagram, chart or photo " +
  "carries meaning, describe it in one line inside [brackets]. Output only the content — no " +
  "preamble, page labels or commentary. If there is no text at all, output nothing.";

/* Room for a batch of dense pages; the pipeline sends at most a handful of
   pages (or one short PDF) per call. */
export const READ_DOCUMENT_MAX_TOKENS = 16000;

/* Image types every vision provider here accepts inline. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isPdfPart(part: DocumentPart): boolean {
  return part.mimeType === "application/pdf";
}

export function isImagePart(part: DocumentPart): boolean {
  return IMAGE_TYPES.has(part.mimeType);
}

/* Engines without native PDF input call this first so a mis-routed PDF fails
   with a clear message instead of a provider 400. */
export function assertImageParts(parts: DocumentPart[], provider: string): void {
  const bad = parts.find((p) => !isImagePart(p));
  if (bad) {
    throw new EngineError(`${provider} can't read ${bad.mimeType} directly — send page images instead.`, "unsupported");
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/* Ollama model names that take images. Local mode's default (qwen2.5:3b) is
   text-only, so visual reading there needs one of these picked in Settings. */
export function isLocalVisionModel(model: string): boolean {
  return /llava|vision|moondream|minicpm-v|qwen[\d.]*-?vl|gemma3(?!n)|llama4|mistral-small3\.[12]/i.test(model);
}
