import type { IngestResult } from "./index";

const MAX_TITLE_LEN = 80;

/* First non-empty line, capped to MAX_TITLE_LEN chars. */
function deriveTitle(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > MAX_TITLE_LEN ? trimmed.slice(0, MAX_TITLE_LEN).trim() : trimmed;
    }
  }
  return undefined;
}

export function ingestText(text: string): IngestResult {
  const trimmed = text.trim();
  return { text: trimmed, title: deriveTitle(trimmed) };
}

function fileName(file: File | Blob): string | undefined {
  return typeof File !== "undefined" && file instanceof File ? file.name : undefined;
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^./\\]+$/, "")
    .trim()
    .slice(0, MAX_TITLE_LEN);
}

/* Bytes of a .txt / .md file → text. UTF-8 is the default. A byte-order mark
   picks UTF-16 (Windows Notepad "Unicode" saves UTF-16 LE with a BOM) or is
   dropped for UTF-8. Bytes that are not valid UTF-8 are read as Windows-1252
   (Notepad "ANSI"), so "café" stays "café" instead of turning into "caf�". */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    // TextDecoder drops a UTF-8 BOM by itself (ignoreBOM defaults to false).
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/* A .txt or .md upload. Read the same way as a PDF or DOCX upload: the whole
   file, no size limit of its own (note generation splits long sources into
   sections), the title from the file name, and a read failure explained in
   words. Before this, these uploads reached ingest() as kind "text" with a
   File but no `text`, and every one failed with "No readable content found." */
export async function ingestTextFile(file: File | Blob): Promise<IngestResult> {
  try {
    const text = decodeText(new Uint8Array(await file.arrayBuffer())).trim();
    const name = fileName(file);
    return {
      text,
      title: name ? titleFromFilename(name) : deriveTitle(text),
      meta: { filename: name },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't read text from that document (${reason}).`);
  }
}
