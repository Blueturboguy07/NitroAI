/* Source ingestion — turns any supported source kind into normalized text
   that note generation can use as grounding context. */

import type { SourceKind } from "../types";
import { ingestText } from "./text";
import { ingestUrl } from "./url";
import { ingestYoutube } from "./youtube";
import { ingestPdf } from "./pdf";
import { ingestDocx } from "./docx";

export interface IngestInput {
  kind: SourceKind;
  text?: string;
  url?: string;
  file?: File | Blob;
  filename?: string;
}

export interface IngestResult {
  text: string;
  title?: string;
  meta?: Record<string, string | number | undefined>;
  /* True for sources (audio) whose text isn't known yet — the engine still
     needs to transcribe `audio` before notes can be generated. */
  needsTranscription?: boolean;
  audio?: Blob;
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[^./\\]+$/, "")
    .trim()
    .slice(0, 80);
}

/* Fill in title/filename from the upload's filename when the format-specific
   extractor couldn't derive one itself (e.g. a bare Blob with no .name). */
function withFilenameFallback(result: IngestResult, filename?: string): IngestResult {
  if (!filename) return result;
  const meta = { ...result.meta };
  if (meta.filename === undefined) meta.filename = filename;
  return {
    ...result,
    title: result.title ?? titleFromFilename(filename),
    meta,
  };
}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  switch (input.kind) {
    case "blank":
      return { text: "" };

    case "text":
      return ingestText(input.text ?? "");

    case "url": {
      if (!input.url) throw new Error("A URL is required to ingest a web page.");
      return ingestUrl(input.url);
    }

    case "youtube": {
      if (!input.url) throw new Error("A YouTube URL is required.");
      return ingestYoutube(input.url);
    }

    case "pdf": {
      if (!input.file) throw new Error("A PDF file is required.");
      const result = await ingestPdf(input.file);
      return withFilenameFallback(result, input.filename);
    }

    case "docx": {
      if (!input.file) throw new Error("A DOCX file is required.");
      const result = await ingestDocx(input.file);
      return withFilenameFallback(result, input.filename);
    }

    case "audio": {
      const { file, filename } = input;
      /* Transcription happens later via the engine — we just hand back the
         audio blob and mark the note as pending transcription. */
      return {
        text: "",
        needsTranscription: true,
        audio: file,
        meta: { filename },
      };
    }

    default: {
      const exhaustive: never = input.kind;
      throw new Error(`Unsupported source kind: ${String(exhaustive)}`);
    }
  }
}
