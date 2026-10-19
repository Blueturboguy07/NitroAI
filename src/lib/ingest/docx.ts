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

/* A .docx is a zip; mammoth's zip reader fails this way on anything else —
   most often a legacy binary .doc renamed or picked by the .doc filter. */
function docxError(err: unknown, name?: string): Error {
  const reason = err instanceof Error ? err.message : String(err);
  if (/\.doc$/i.test(name ?? "") || /central directory|zip file|not a valid zip/i.test(reason)) {
    return new Error(
      "This isn't a .docx file — older Word .doc files can't be read. Open it in Word, Pages or Google Docs and save it as .docx or PDF.",
    );
  }
  return new Error(`Couldn't extract text from that document (${reason}).`);
}

/* Extract raw text from a .docx via mammoth. mammoth import is lazy so this
   chunk only loads when a docx is actually ingested. */
export async function ingestDocx(file: File | Blob, filename?: string): Promise<IngestResult> {
  const name = fileName(file);
  try {
    const mammoth = await import("mammoth");
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = result.value.trim();
    return {
      text,
      title: name ? titleFromFilename(name) : undefined,
      meta: { filename: name },
    };
  } catch (err) {
    throw docxError(err, filename ?? name);
  }
}

/* Image types vision engines take inline; Word also embeds EMF/WMF drawings,
   which no engine reads and are skipped. */
const READABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/* Embedded images of a .docx, in document order — the input for reading an
   image-only document (e.g. pasted slide screenshots) visually. `skipped`
   counts images in formats no engine can read. */
export async function extractDocxImages(
  file: Blob,
  maxImages = 40,
): Promise<{ images: Blob[]; skipped: number }> {
  const mammoth = await import("mammoth");
  // Reads are queued in the order mammoth meets the images, then awaited
  // together, so the result keeps document order.
  const reads: Promise<Blob>[] = [];
  let skipped = 0;
  await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    {
      convertImage: mammoth.images.imgElement((image) => {
        const type = image.contentType.toLowerCase();
        if (!READABLE_IMAGE_TYPES.has(type)) skipped++;
        else if (reads.length < maxImages) {
          reads.push(image.readAsArrayBuffer().then((buf) => new Blob([buf], { type })));
        }
        return Promise.resolve({ src: "" });
      }),
    },
  );
  return { images: await Promise.all(reads), skipped };
}
