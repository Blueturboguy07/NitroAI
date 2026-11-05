import type { IngestResult } from "./index";
import { titleFromFilename } from "./text";

function fileName(file: File | Blob): string | undefined {
  return typeof File !== "undefined" && file instanceof File ? file.name : undefined;
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
    // The library's own words ("Can't find end of central directory …",
    // "Could not find main document part") never reach the user.
    console.warn("NitroAI: Word reader failed", err);
    const what = fileName(file) ? `"${fileName(file)}"` : "that Word file";
    throw new Error(`NitroAI couldn't read the text in ${what}. The file may be damaged or not a Word .docx file. Open it in Word and save it as .docx again (File > Save As), then upload that.`);
  }
}
