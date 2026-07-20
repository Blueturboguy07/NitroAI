import type { IngestResult } from "./index";

function fileName(file: File | Blob): string | undefined {
  return typeof File !== "undefined" && file instanceof File ? file.name : undefined;
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^./\\]+$/, "")
    .trim()
    .slice(0, 80);
}

/* Extract raw text from a .docx via mammoth. mammoth import is lazy so this
   chunk only loads when a docx is actually ingested. */
export async function ingestDocx(file: File | Blob): Promise<IngestResult> {
  try {
    const mammoth = await import("mammoth");
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = result.value.trim();
    const name = fileName(file);
    return {
      text,
      title: name ? titleFromFilename(name) : undefined,
      meta: { filename: name },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't extract text from that document (${reason}).`);
  }
}
