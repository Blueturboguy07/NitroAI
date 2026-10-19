import type { IngestResult } from "./index";

/* A page "has text" when its text layer carries at least this many
   non-whitespace characters. Below that it is a scan, a picture-only slide,
   or just a page number — see needsVisualRead() in ./visual. */
export const MIN_PAGE_CHARS = 20;

function fileName(file: File | Blob): string | undefined {
  return typeof File !== "undefined" && file instanceof File ? file.name : undefined;
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^./\\]+$/, "")
    .trim()
    .slice(0, 80);
}

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

/* pdfjs-dist is browser-only — it relies on DOM globals (DOMMatrix, etc.)
   that don't exist under Node — so the import is lazy: nothing here loads
   unless a PDF is actually opened. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([
    import("pdfjs-dist"),
    // eslint-disable-next-line import/no-unresolved -- Vite `?url` asset import
    import("pdfjs-dist/build/pdf.worker.min.mjs?url").then((m) => m.default),
  ])
    .then(([pdfjs, workerUrl]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })
    .catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
  return pdfjsPromise;
}

/* CMaps, standard fonts and the wasm image decoders, served at /pdfjs/ by
   vite.pdfjs-plugin.ts. Absolute, because the worker resolves them against
   its own URL. */
function assetUrls(): Record<string, string> {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  };
}

async function openPdf(file: Blob) {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapPacked: true,
    ...assetUrls(),
  });
}

/* pdf.js names its exceptions; the two a user can act on get their own
   message. */
function openError(err: unknown): Error {
  const name = err instanceof Error ? err.name : "";
  if (name === "PasswordException") {
    return new Error("This PDF is password-protected. Remove the password (or print it to a new PDF) and upload it again.");
  }
  if (name === "InvalidPDFException") {
    return new Error("This file isn't a valid PDF, or it's damaged. Try re-exporting it.");
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(`Couldn't extract text from that PDF (${reason}).`);
}

/* Extract text from every page of a PDF via pdfjs-dist. Browser-only.
   `meta.textPages` counts pages that actually had a text layer, so the
   pipeline can spot scanned / image-only PDFs and read them visually. */
export async function ingestPdf(file: File | Blob): Promise<IngestResult> {
  if (typeof window === "undefined") {
    throw new Error("PDF extraction is only supported in the browser.");
  }

  let loadingTask: Awaited<ReturnType<typeof openPdf>> | undefined;
  try {
    loadingTask = await openPdf(file);
    const doc = await loadingTask.promise;

    const pages: string[] = [];
    let textPages = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      pages.push(pageText);
      if (pageText.replace(/\s+/g, "").length >= MIN_PAGE_CHARS) textPages++;
      page.cleanup();
    }

    const text = pages.join("\n\n").trim();
    const name = fileName(file);
    return {
      text,
      title: name ? titleFromFilename(name) : undefined,
      meta: { filename: name, pages: pages.length, textPages },
    };
  } catch (err) {
    throw openError(err);
  } finally {
    // Frees the worker-side document on success and failure alike.
    await loadingTask?.destroy().catch(() => {});
  }
}

export interface RenderPagesOptions {
  /* Only the first `maxPages` pages are rendered. */
  maxPages?: number;
  /* Longest side of each page image, in pixels. ~1600 keeps slide and
     handout text legible to vision models without bloating the request. */
  maxSide?: number;
  signal?: AbortSignal;
}

/* Render PDF pages to JPEG images for engines that read images but not PDFs
   (OpenAI, local vision models), or PDFs too long to send whole. */
export async function renderPdfPages(
  file: Blob,
  opts: RenderPagesOptions = {},
): Promise<{ images: Blob[]; total: number }> {
  if (typeof document === "undefined") {
    throw new Error("Rendering PDF pages is only supported in the browser.");
  }
  const { maxPages = 40, maxSide = 1600, signal } = opts;

  let loadingTask: Awaited<ReturnType<typeof openPdf>> | undefined;
  let doc: Awaited<Awaited<ReturnType<typeof openPdf>>["promise"]>;
  try {
    loadingTask = await openPdf(file);
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask?.destroy().catch(() => {});
    throw openError(err);
  }

  try {
    const count = Math.min(doc.numPages, maxPages);
    const images: Blob[] = [];
    const canvas = document.createElement("canvas");
    for (let i = 1; i <= count; i++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(i);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(maxSide / Math.max(unscaled.width, unscaled.height), 3);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // pdf.js paints a white background first, so JPEG has no black corners.
      await page.render({ canvas, viewport }).promise;
      images.push(await canvasToJpeg(canvas));
      page.cleanup();
    }
    canvas.width = canvas.height = 0; // release the backing store
    return { images, total: doc.numPages };
  } finally {
    await loadingTask!.destroy().catch(() => {});
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Couldn't render a PDF page to an image."))),
      "image/jpeg",
      0.85,
    ),
  );
}
