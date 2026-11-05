import type { IngestResult } from "./index";
import { MAX_TEXT_FILE_BYTES, checkDocument, textTooLargeMessage } from "./fileTypes";

export { decodeText } from "./fileTypes";

const MAX_TITLE_LEN = 80;

/* A title of at most `max` characters, cut at a word boundary: a pasted
   text's first line used to be cut in the middle of a word. A single word
   longer than the cut (a URL) is cut where it must be. */
export function cutTitle(text: string, max = MAX_TITLE_LEN): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,;:.\-–—]+$/, "");
}

/* First non-empty line, cut at a word boundary. */
function deriveTitle(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return cutTitle(trimmed);
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

export function titleFromFilename(name: string): string {
  return cutTitle(name.replace(/\.[^./\\]+$/, ""));
}

/* A .txt or .md upload (or a chat attachment that is text): the whole file,
   the title from the file name. The shared check (fileTypes.checkDocument)
   refuses a file over 2 MB, a known binary format (a PDF, an Office file …,
   also after a byte-order mark) and text that decodes to more than 2% U+FFFD
   or control characters — before anything is sent to a model. Before this
   reader, these uploads failed with "No readable content found."; in
   89b3aa4–69b560a a renamed PDF or .pptx could get through as "text". */
export async function ingestTextFile(file: File | Blob, filename?: string): Promise<IngestResult> {
  const name = fileName(file) ?? filename;
  // Refuse before the whole file is read into memory.
  if (file.size > MAX_TEXT_FILE_BYTES) throw new Error(textTooLargeMessage(name, file.size));
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    console.warn("NitroAI: text file read failed", err);
    throw new Error(`NitroAI couldn't open ${name ? `"${name}"` : "that file"}. Check that the file is still there, then try again.`);
  }
  const checked = checkDocument(name, "text", bytes.length, bytes);
  if (checked.problem !== null) throw new Error(checked.problem);
  const text = (checked.text ?? "").trim();
  return {
    text,
    title: name ? titleFromFilename(name) : deriveTitle(text),
    meta: { filename: name },
  };
}
