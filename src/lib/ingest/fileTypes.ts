/* Which uploaded files NitroAI reads, and the words it shows for the others.
   One list, used by the upload window (on pick AND on drop — a drop skips the
   file dialog's filter) and by ingest() itself, so a file that NitroAI cannot
   read is stopped before any model call. Before this, every file that was not
   .pdf/.doc/.docx was read as text: a dropped .pptx (a zip) became about 8
   paid calls and a note of garbage. */

export type DocumentKind = "pdf" | "docx" | "text";

export const UNSUPPORTED_FILE_MESSAGE =
  "NitroAI reads PDF, Word (.docx, .doc), .txt and .md files. For slides, save them as PDF and upload that.";

/* A .txt / .md file larger than this is refused. 2 MB of plain text is about
   350,000 words, far more than one note can use. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/* How much of a "text" file is checked for binary data (a NUL byte). */
export const BINARY_SNIFF_BYTES = 8 * 1024;

export const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.txt,.md";

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/* .pdf → pdf, .docx/.doc → docx, .txt/.md → text. Every other name → null. */
export function documentKind(name: string): DocumentKind | null {
  switch (extensionOf(name)) {
    case "pdf":
      return "pdf";
    case "docx":
    case "doc":
      return "docx";
    case "txt":
    case "md":
      return "text";
    default:
      return null;
  }
}

export function unsupportedFileMessage(name?: string): string {
  return name ? `NitroAI can't read "${name}". ${UNSUPPORTED_FILE_MESSAGE}` : UNSUPPORTED_FILE_MESSAGE;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function textTooLargeMessage(name: string | undefined, bytes: number): string {
  const what = name ? `"${name}"` : "This text file";
  return `${what} is ${megabytes(bytes)}. NitroAI reads .txt and .md files up to 2 MB. Split it into smaller files, or save it as PDF and upload that.`;
}

export function binaryTextMessage(name?: string): string {
  const what = name ? `"${name}"` : "This file";
  return `${what} is not plain text (it contains binary data). ${UNSUPPORTED_FILE_MESSAGE}`;
}

/* True when the start of the file has a NUL byte. A UTF-16 file (it starts
   with a byte-order mark) has NUL bytes in normal text, so it is not checked. */
export function looksBinary(head: Uint8Array): boolean {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
    return false;
  }
  const n = Math.min(head.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

/* The size and binary checks for a .txt / .md file, from its size and its
   first bytes. Returns the message to show, or null when the file is good. */
export function textFileProblem(name: string | undefined, size: number, head: Uint8Array): string | null {
  if (size > MAX_TEXT_FILE_BYTES) return textTooLargeMessage(name, size);
  if (looksBinary(head)) return binaryTextMessage(name);
  return null;
}

async function readHead(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, BINARY_SNIFF_BYTES).arrayBuffer());
}

/* The upload window's check for one picked or dropped file. */
export async function documentFileProblem(file: File): Promise<string | null> {
  const kind = documentKind(file.name);
  if (!kind) return unsupportedFileMessage(file.name);
  if (kind !== "text") return null;
  if (file.size > MAX_TEXT_FILE_BYTES) return textTooLargeMessage(file.name, file.size);
  return textFileProblem(file.name, file.size, await readHead(file));
}
