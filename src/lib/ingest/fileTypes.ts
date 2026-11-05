/* Which files NitroAI reads, and the words it shows for the others. ONE
   check, used by the upload window (on pick AND on drop — a drop skips the
   file dialog's filter), by ingest() itself, by chat attachments and by the
   Website-link reader, so a file that NitroAI cannot read is stopped before
   any model call.

   History: 89b3aa4 read every upload that was not .pdf/.doc/.docx as text (a
   dropped .pptx became 8 paid calls of garbage). 69b560a checked only for a
   NUL byte in the first 8 KB, which a real PDF renamed .txt often does not
   have (TypeBullet.pdf: 9 calls), and skipped the check after FF FE. Now a
   file is refused on a known binary signature (also after a byte-order mark)
   and, after decoding, when more than 2% of its characters are U+FFFD or
   control characters. */

export type DocumentKind = "pdf" | "docx" | "text";

export const UNSUPPORTED_FILE_MESSAGE =
  "NitroAI reads PDF, Word (.docx), .txt and .md files. For slides, save them as PDF and upload that.";

/* Old binary Word files (.doc, Word 97–2003): the .docx reader cannot open them. */
export const OLD_WORD_ADVICE = "Save it as .docx (Word: File > Save As), then upload that.";

/* A .txt / .md file (or the text of a web page) larger than this is refused.
   2 MB of plain text is about 350,000 words, far more than one note can use. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/* How much of a "text" file is checked for a NUL byte. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/* Decoded text with more than this share of U+FFFD or control characters
   (other than tab, CR and LF) is binary data, not text. */
export const MAX_GARBLED_SHARE = 0.02;

export const DOCUMENT_ACCEPT = ".pdf,.docx,.txt,.md";

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/* .pdf → pdf, .docx → docx, .txt/.md → text. Every other name (.doc too) → null. */
export function documentKind(name: string): DocumentKind | null {
  switch (extensionOf(name)) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "txt":
    case "md":
      return "text";
    default:
      return null;
  }
}

const quoted = (name: string | undefined, fallback: string) => (name ? `"${name}"` : fallback);

export function unsupportedFileMessage(name?: string): string {
  if (name && extensionOf(name) === "doc") return oldWordMessage(name);
  return name ? `NitroAI can't read "${name}". ${UNSUPPORTED_FILE_MESSAGE}` : UNSUPPORTED_FILE_MESSAGE;
}

export function oldWordMessage(name?: string): string {
  return `${quoted(name, "This file")} is an old Word file (.doc), and NitroAI can't read it. ${OLD_WORD_ADVICE}`;
}

/* To 0.01 MB. A file over the limit never reads "2.00 MB" (or "2.0 MB … up
   to 2 MB"): it reads at least 2.01 MB. */
function megabytes(bytes: number): string {
  let mb = Math.round((bytes / (1024 * 1024)) * 100) / 100;
  if (bytes > MAX_TEXT_FILE_BYTES && mb <= 2) mb = 2.01;
  return `${mb.toFixed(2)} MB`;
}

export function textTooLargeMessage(name: string | undefined, bytes: number): string {
  return `${quoted(name, "This text file")} is ${megabytes(bytes)}. NitroAI reads .txt and .md files up to 2 MB. Split it into smaller files, or save it as PDF and upload that.`;
}

export function binaryTextMessage(name?: string): string {
  return `${quoted(name, "This file")} is not plain text (it contains binary data). ${UNSUPPORTED_FILE_MESSAGE}`;
}

/* ---- Signatures --------------------------------------------------------- */

export type Signature =
  | "pdf" | "zip" | "ole" | "png" | "jpeg" | "gif" | "riff" | "ogg" | "id3" | "mp4" | "7z" | "rar" | "gzip";

type Magic = { sig: Signature; at: number; bytes: number[]; also?: (b: Uint8Array, start: number) => boolean };

const MAGIC: Magic[] = [
  { sig: "pdf", at: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { sig: "zip", at: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\x03\x04: zip, .docx, .pptx, .xlsx
  { sig: "ole", at: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0] }, // OLE: .doc, .ppt, .xls
  { sig: "png", at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { sig: "jpeg", at: 0, bytes: [0xff, 0xd8, 0xff] },
  { sig: "gif", at: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  // RIFF + size + a 4-letter form type (WAVE, AVI , WEBP): .wav, .avi, .webp
  { sig: "riff", at: 0, bytes: [0x52, 0x49, 0x46, 0x46], also: (b, s) => [8, 9, 10, 11].every((i) => (b[s + i] >= 0x41 && b[s + i] <= 0x5a) || b[s + i] === 0x20) },
  { sig: "ogg", at: 0, bytes: [0x4f, 0x67, 0x67, 0x53], also: (b, s) => b[s + 4] === 0 }, // OggS + version 0
  // ID3 + a version byte (2–4): an MP3 tag. Plain text that starts "ID3" is not refused.
  { sig: "id3", at: 0, bytes: [0x49, 0x44, 0x33], also: (b, s) => b[s + 3] >= 2 && b[s + 3] <= 4 },
  { sig: "mp4", at: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp at offset 4: .mp4, .m4a, .mov
  { sig: "7z", at: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { sig: "rar", at: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a] }, // Rar!\x1a
  { sig: "gzip", at: 0, bytes: [0x1f, 0x8b] },
];

function bomLength(b: Uint8Array): number {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 3;
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return 2;
  return 0;
}

function isUtf16(b: Uint8Array): boolean {
  return bomLength(b) === 2;
}

function matchAt(b: Uint8Array, start: number, m: Magic): boolean {
  const off = start + m.at;
  if (b.length < off + m.bytes.length) return false;
  for (let i = 0; i < m.bytes.length; i++) if (b[off + i] !== m.bytes[i]) return false;
  return m.also ? m.also(b, start) : true;
}

/* The known binary format the bytes start with — at offset 0, or right after
   a byte-order mark (FF FE + a .pptx is still a .pptx). */
export function signatureOf(b: Uint8Array): Signature | null {
  for (const start of new Set([0, bomLength(b)])) {
    for (const m of MAGIC) if (matchAt(b, start, m)) return m.sig;
  }
  return null;
}

/* A PDF may have up to 1 KB of other bytes before "%PDF-". */
function hasPdfHeader(b: Uint8Array): boolean {
  const n = Math.min(b.length, 1024);
  for (let i = 0; i + 5 <= n; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  }
  return false;
}

/* The part names in a zip (or a sample of one): read from each local file
   header (PK 03 04, name at +30) and central directory entry (PK 01 02, name
   at +46). Names are stored as plain bytes, never compressed. */
export function zipNames(b: Uint8Array): string[] {
  const names: string[] = [];
  const latin1 = new TextDecoder("latin1");
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b) continue;
    let at = -1;
    let len = 0;
    if (b[i + 2] === 0x03 && b[i + 3] === 0x04 && i + 30 <= b.length) {
      len = b[i + 26] | (b[i + 27] << 8);
      at = i + 30;
    } else if (b[i + 2] === 0x01 && b[i + 3] === 0x02 && i + 46 <= b.length) {
      len = b[i + 28] | (b[i + 29] << 8);
      at = i + 46;
    }
    if (at < 0 || len === 0 || len > 512 || at + len > b.length) continue;
    const name = latin1.decode(b.subarray(at, at + len));
    if (/^[\x20-\x7e]+$/.test(name)) names.push(name);
  }
  return names;
}

/* Which Office app made a zip, from its part names (word/, ppt/, xl/). */
export function zipFlavor(b: Uint8Array): "word" | "powerpoint" | "excel" | null {
  const names = zipNames(b);
  if (names.some((n) => n.startsWith("word/"))) return "word";
  if (names.some((n) => n.startsWith("ppt/"))) return "powerpoint";
  if (names.some((n) => n.startsWith("xl/"))) return "excel";
  return null;
}

function signatureWords(sig: Signature, b: Uint8Array): string {
  switch (sig) {
    case "pdf":
      return "a PDF file";
    case "zip": {
      const flavor = zipFlavor(b);
      return flavor === "word"
        ? "a Word file (.docx)"
        : flavor === "powerpoint"
          ? "a PowerPoint file"
          : flavor === "excel"
            ? "an Excel file"
            : "a zip file";
    }
    case "ole":
      return "an old Office file (.doc, .ppt or .xls)";
    case "png":
    case "jpeg":
    case "gif":
      return "an image";
    case "riff":
    case "ogg":
    case "id3":
    case "mp4":
      return "an audio or video file";
    default:
      return "a compressed archive";
  }
}

/* ---- Text --------------------------------------------------------------- */

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

/* Share of characters that are U+FFFD or C0 controls other than tab, CR, LF. */
export function garbledShare(text: string): number {
  if (!text.length) return 0;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) bad++;
  }
  return bad / text.length;
}

/* True when the start of the file has a NUL byte. A UTF-16 file (it starts
   with a byte-order mark) has NUL bytes in normal text, so it is not checked. */
export function looksBinary(head: Uint8Array): boolean {
  if (isUtf16(head)) return false;
  const n = Math.min(head.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

/* What the shared check found in some bytes that should be text. */
export type TextFinding = { ok: true; text: string } | { ok: false; signature: Signature | null; words: string };

/* The shared check for bytes that should be text: a .txt/.md upload, a chat
   attachment, a web page. Size is checked by the caller (it knows the size
   before it reads the bytes). */
export function inspectText(bytes: Uint8Array): TextFinding {
  const sig = signatureOf(bytes);
  if (sig) return { ok: false, signature: sig, words: signatureWords(sig, bytes) };
  if (looksBinary(bytes)) return { ok: false, signature: null, words: "binary data" };
  const text = decodeText(bytes);
  if (garbledShare(text) > MAX_GARBLED_SHARE) return { ok: false, signature: null, words: "binary data" };
  return { ok: true, text };
}

/* The message for a .txt / .md file that is not text. */
function notTextMessage(name: string | undefined, f: Extract<TextFinding, { ok: false }>, bytes: Uint8Array): string {
  const what = quoted(name, "This file");
  if (f.signature === "pdf") return `${what} is a PDF file, not a text file. Change its name to end in .pdf, then upload it as a PDF.`;
  if (f.signature === "zip" && zipFlavor(bytes) === "word") {
    return `${what} is a Word file, not a text file. Change its name to end in .docx, then upload it.`;
  }
  if (f.signature) return `${what} is ${f.words}, not a text file. ${UNSUPPORTED_FILE_MESSAGE}`;
  return binaryTextMessage(name);
}

/* ---- The one document check -------------------------------------------- */

export type DocumentCheck = { problem: string; text?: undefined } | { problem: null; text?: string };

/* `bytes` is the whole file for a .txt/.md (≤ 2 MB), else a sample (the
   start and the end of the file, see readSample). Returns the message to
   show, or null and — for .txt/.md — the decoded text. */
export function checkDocument(name: string | undefined, kind: DocumentKind, size: number, bytes: Uint8Array): DocumentCheck {
  const what = quoted(name, "This file");
  if (kind === "text") {
    if (size > MAX_TEXT_FILE_BYTES) return { problem: textTooLargeMessage(name, size) };
    const f = inspectText(bytes);
    return f.ok ? { problem: null, text: f.text } : { problem: notTextMessage(name, f, bytes) };
  }

  const sig = signatureOf(bytes);
  if (kind === "pdf") {
    if (hasPdfHeader(bytes)) return { problem: null };
    if (sig === "zip" && zipFlavor(bytes) === "powerpoint") {
      return { problem: `${what} is a PowerPoint file, not a PDF. For slides, save them as PDF and upload that.` };
    }
    if (sig) return { problem: `${what} is ${signatureWords(sig, bytes)}, not a PDF. ${UNSUPPORTED_FILE_MESSAGE}` };
    return { problem: `${what} is not a PDF file, so NitroAI can't read it. Open it in the app that made it and save it as PDF again.` };
  }

  // kind === "docx"
  if (sig === "zip") {
    const flavor = zipFlavor(bytes);
    if (flavor === "powerpoint") return { problem: `${what} is a PowerPoint file, not a Word file. For slides, save them as PDF and upload that.` };
    if (flavor === "excel") return { problem: `${what} is an Excel file, not a Word file. ${UNSUPPORTED_FILE_MESSAGE}` };
    if (flavor === "word") return { problem: null };
    return { problem: `${what} is a zip file with no Word document in it, so NitroAI can't read it. Open it in Word and save it as .docx again.` };
  }
  if (sig === "ole") return { problem: oldWordMessage(name) };
  if (sig === "pdf") return { problem: `${what} is a PDF file, not a Word file. Change its name to end in .pdf, then upload it as a PDF.` };
  if (sig) return { problem: `${what} is ${signatureWords(sig, bytes)}, not a Word file. ${UNSUPPORTED_FILE_MESSAGE}` };
  if (inspectText(bytes).ok) {
    return { problem: `${what} is a text file, not a Word file. Change its name to end in .txt, then upload it.` };
  }
  return { problem: `${what} is not a Word .docx file, so NitroAI can't read it. Open it in Word and save it as .docx again.` };
}

/* The bytes checkDocument needs: the whole file for .txt/.md (after the size
   check), else the first 64 KB and the last 256 KB (a zip lists its part
   names at the end). */
export async function readSample(file: Blob, kind: DocumentKind): Promise<Uint8Array> {
  const HEAD = 64 * 1024;
  const TAIL = 256 * 1024;
  if (kind === "text" || file.size <= HEAD + TAIL) return new Uint8Array(await file.arrayBuffer());
  const [head, tail] = await Promise.all([
    file.slice(0, HEAD).arrayBuffer(),
    file.slice(file.size - TAIL).arrayBuffer(),
  ]);
  const out = new Uint8Array(HEAD + TAIL);
  out.set(new Uint8Array(head), 0);
  out.set(new Uint8Array(tail), HEAD);
  return out;
}

/* The upload window's check for one picked or dropped file. */
export async function documentFileProblem(file: File): Promise<string | null> {
  const kind = documentKind(file.name);
  if (!kind) return unsupportedFileMessage(file.name);
  if (kind === "text" && file.size > MAX_TEXT_FILE_BYTES) return textTooLargeMessage(file.name, file.size);
  return checkDocument(file.name, kind, file.size, await readSample(file, kind)).problem;
}

/* ---- Audio window ------------------------------------------------------- */

const AUDIO_HELP = 'NitroAI transcribes audio and video files such as MP3, M4A, WAV, MP4 and WEBM.';

export const UNREADABLE_AUDIO_MESSAGE = `NitroAI couldn't read this recording. ${AUDIO_HELP}`;

/* A file in the audio window that is clearly not audio or video (a PDF, an
   Office file, an image, an archive, plain text) is refused before it is
   sent to be transcribed. */
export function audioFileProblem(name: string | undefined, head: Uint8Array): string | null {
  const what = quoted(name, "This file");
  const sig = signatureOf(head);
  if (sig === "riff" || sig === "ogg" || sig === "id3" || sig === "mp4") return null;
  if (sig) return `${what} is ${signatureWords(sig, head)}, not an audio or video file. ${AUDIO_HELP}`;
  if (head.length && !looksBinary(head) && garbledShare(decodeText(head)) <= MAX_GARBLED_SHARE) {
    return `${what} is a text file, not an audio or video file. Use "Document upload" for text. ${AUDIO_HELP}`;
  }
  return null;
}

export async function audioBlobProblem(file: Blob, name?: string): Promise<string | null> {
  return audioFileProblem(name, new Uint8Array(await file.slice(0, BINARY_SNIFF_BYTES).arrayBuffer()));
}
