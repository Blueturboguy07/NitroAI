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

/* Extract text from every page of a PDF via pdfjs-dist. Browser-only — the
   library relies on DOM globals (DOMMatrix, etc.) that don't exist under
   Node, so both the guard and the import itself are lazy: nothing here runs
   (or is even loaded) unless this function is actually called. */
export async function ingestPdf(file: File | Blob): Promise<IngestResult> {
  if (typeof window === "undefined") {
    throw new Error("PDF extraction is only supported in the browser.");
  }

  try {
    const [pdfjs, workerUrl] = await Promise.all([
      import("pdfjs-dist"),
      // eslint-disable-next-line import/no-unresolved -- Vite `?url` asset import
      import("pdfjs-dist/build/pdf.worker.min.mjs?url").then((m) => m.default),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const data = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data });
    const doc = await loadingTask.promise;

    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      pages.push(pageText);
      page.cleanup();
    }
    await loadingTask.destroy();

    const text = pages.join("\n\n").trim();
    const name = fileName(file);
    return {
      text,
      title: name ? titleFromFilename(name) : undefined,
      meta: { filename: name, pages: pages.length },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't extract text from that PDF (${reason}).`);
  }
}
