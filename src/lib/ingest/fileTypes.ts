/* Which files NitroAI reads, and the words it shows for the others. ONE
   check, used by the upload window (on pick AND on drop — a drop skips the
   file dialog's filter), by ingest() itself, by chat attachments and by the
   Website-link reader, so a file that NitroAI cannot read is stopped before
   any model call.

   History: 89b3aa4 read every upload that was not .pdf/.doc/.docx as text (a
   dropped .pptx became 8 paid calls of garbage). 69b560a checked only for a
   NUL byte in the first 8 KB, which a real PDF renamed .txt often does not
   have (TypeBullet.pdf: 9 calls), and skipped the check after FF FE. Now a
   file is refused on a known binary signature (also after a byte-order mark,
   and a PDF header up to 1 KB in), and after decoding when it has too many
   stray control characters or broken UTF-16 (see looksLikeText for the
   limits and the corpus they come from). */

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

/* Limits for bytes that should be text, chosen from a corpus (round 5, see
   looksLikeText and text-check-corpus.test.ts for the numbers). */
export const MAX_CONTROL_SHARE = 0.05;
export const MAX_BROKEN_UTF16_SHARE = 0.001;
/* Below this many bad characters a text is never refused: in a short text
   one or two marks give a large share. 1 KB of binary data has about 100. */
export const MIN_BAD_CHARACTERS = 8;

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

/* The OLE signature is the same for .doc, .ppt and .xls, so a file with
   another name and OLE bytes may be any of the three. */
export function oldOfficeMessage(name?: string): string {
  return `${quoted(name, "This file")} is an old Office file (.doc, .ppt or .xls), and NitroAI can't read it. Save a Word file as .docx (Word: File > Save As) and slides as PDF, then upload that.`;
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

/* PDF readers accept up to 1 KB of other bytes before "%PDF-". */
const PDF_HEADER_WINDOW = 1024;

function indexOfAscii(b: Uint8Array, word: string, from: number, to: number): number {
  const end = Math.min(b.length, to) - word.length;
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let j = 0; j < word.length; j++) if (b[i + j] !== word.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/* For a file named .pdf: "%PDF-" in the first 1 KB is enough. */
export function hasPdfHeader(b: Uint8Array): boolean {
  return indexOfAscii(b, "%PDF-", 0, PDF_HEADER_WINDOW) >= 0;
}

/* For bytes that should be text: a PDF with other bytes before its header
   (the header is not at offset 0, so signatureOf misses it). A text file can
   mention "%PDF-" near its start, so this also needs a version number after
   it ("%PDF-1.7") and "%%EOF" in the last 1 KB, as every PDF has. Corpus:
   1,018 of 1,018 system PDFs end that way; 0 of 1,898 real text files do. */
export function isPdfAfterJunk(b: Uint8Array): boolean {
  const at = indexOfAscii(b, "%PDF-", 0, PDF_HEADER_WINDOW);
  if (at < 0) return false;
  const digit = (x: number | undefined) => x !== undefined && x >= 0x30 && x <= 0x39;
  if (!digit(b[at + 5]) || b[at + 6] !== 0x2e || !digit(b[at + 7])) return false;
  return indexOfAscii(b, "%%EOF", b.length - 1024, b.length) >= 0;
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

/* The control characters in a text that real text does not have. NOT
   counted: tab, LF, CR, form feed (pdftotext puts one between pages) and
   vertical tab (PowerPoint copies a soft line break as \v); ESC that starts
   a terminal colour code (ESC [ …) and a backspace in overstrike (N\bN,
   _\bN), as in a saved terminal log or man page. Every other C0 character
   (NUL included) is counted. */
export function strayControlCount(text: string): number {
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x20 || (c >= 0x09 && c <= 0x0d)) continue;
    if (c === 0x1b && "[]\\()".includes(text[i + 1] ?? "")) continue;
    if (c === 0x08 && i > 0) {
      const a = text[i - 1];
      const b = text[i + 1] ?? "";
      if (a > " " && b > " " && (a === b || a === "_" || b === "_")) continue;
    }
    bad++;
  }
  return bad;
}

/* UTF-16 only (the bytes start with FF FE or FE FF): the number of 16-bit
   units that are half of a surrogate pair with no other half. The decoder
   turns each one into U+FFFD. Real UTF-16 text has none; other bytes behind
   a byte-order mark have them. */
export function brokenUtf16Count(b: Uint8Array): number {
  if (!isUtf16(b)) return 0;
  const le = b[0] === 0xff;
  const units = (b.length - 2) >> 1;
  const unit = (i: number) => (le ? b[2 + 2 * i] | (b[3 + 2 * i] << 8) : (b[2 + 2 * i] << 8) | b[3 + 2 * i]);
  let bad = 0;
  for (let i = 0; i < units; i++) {
    const u = unit(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = i + 1 < units ? unit(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else bad++;
    } else if (u >= 0xdc00 && u <= 0xdfff) bad++;
  }
  return bad;
}

/* True when decoded bytes read as text. The limits come from a corpus
   (round 5; full numbers in text-check-corpus.test.ts):
   - real text, 1,898 files (pdftotext of 228 PDFs in 3 modes, Markdown,
     licences, source code, HTML, scripts, man pages, RTF via textutil, 150
     UTF-16 .strings files and UTF-16 copies, terminal logs, the verifier's
     B files, and copy-paste variants: ligatures as \x02 or TeX slots, lost
     glyphs as U+FFFD, \v soft breaks, a form feed after every line):
     stray controls at most 2.86% (the verifier's ligature copy; 1.38% in
     the densest file a program made), broken UTF-16 0.
   - binary that gets past the signature, PDF and NUL checks: stray controls
     at least 9.61% (8-bit), broken UTF-16 at least 0.26% (after a BOM).
   5% sits between 2.86% and 9.61%, about 1.8× from each. U+FFFD in the
   file itself is not counted: no binary file made one in an 8-bit decode
   (0 of 2,674), and real text has them where a program lost a glyph (4.61%
   in pdftotext of a real manual, most of a table of contents). */
export function looksLikeText(bytes: Uint8Array, text: string): boolean {
  if (!text.length) return true;
  const controls = strayControlCount(text);
  if (controls >= MIN_BAD_CHARACTERS && controls / text.length > MAX_CONTROL_SHARE) return false;
  const broken = brokenUtf16Count(bytes);
  if (broken >= MIN_BAD_CHARACTERS && broken / text.length > MAX_BROKEN_UTF16_SHARE) return false;
  return true;
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
  const sig = signatureOf(bytes) ?? (isPdfAfterJunk(bytes) ? "pdf" : null);
  if (sig) return { ok: false, signature: sig, words: signatureWords(sig, bytes) };
  if (looksBinary(bytes)) return { ok: false, signature: null, words: "binary data" };
  const text = decodeText(bytes);
  if (!looksLikeText(bytes, text)) return { ok: false, signature: null, words: "binary data" };
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
  if (sig === "ole") return { problem: oldOfficeMessage(name) };
  const found = inspectText(bytes);
  if (sig === "pdf" || (!found.ok && found.signature === "pdf")) {
    return { problem: `${what} is a PDF file, not a Word file. Change its name to end in .pdf, then upload it as a PDF.` };
  }
  if (sig) return { problem: `${what} is ${signatureWords(sig, bytes)}, not a Word file. ${UNSUPPORTED_FILE_MESSAGE}` };
  if (found.ok) {
    return { problem: `${what} is a text file, not a Word file. Change its name to end in .txt, then upload it.` };
  }
  return { problem: `${what} is not a Word .docx file, so NitroAI can't read it. Open it in Word and save it as .docx again.` };
}

/* A file named .doc. Its bytes say what it is: an old Word file (the usual
   case) gets the Save As advice; a .docx, a PowerPoint file, a PDF or text
   with that name gets the message for what it really is. */
export function docFileCheck(name: string | undefined, size: number, bytes: Uint8Array): string {
  const what = quoted(name, "This file");
  const sig = signatureOf(bytes);
  if (!bytes.length || sig === "ole") return oldWordMessage(name);
  if (sig === "zip" && zipFlavor(bytes) === "word") {
    return `${what} is a Word .docx file. Change its name to end in .docx, then upload it.`;
  }
  return checkDocument(name, "docx", size, bytes).problem ?? oldWordMessage(name);
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
/* The message for a file NitroAI does not read, by its name; for a .doc
   name, also by its bytes (see docFileCheck). */
export async function refusedFileMessage(file: Blob, name: string): Promise<string> {
  if (extensionOf(name) === "doc") return docFileCheck(name, file.size, await readSample(file, "docx"));
  return unsupportedFileMessage(name);
}

export async function documentFileProblem(file: File): Promise<string | null> {
  const kind = documentKind(file.name);
  if (!kind) return refusedFileMessage(file, file.name);
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
  if (head.length && !looksBinary(head) && looksLikeText(head, decodeText(head))) {
    return `${what} is a text file, not an audio or video file. Use "Document upload" for text. ${AUDIO_HELP}`;
  }
  return null;
}

export async function audioBlobProblem(file: Blob, name?: string): Promise<string | null> {
  return audioFileProblem(name, new Uint8Array(await file.slice(0, BINARY_SNIFF_BYTES).arrayBuffer()));
}
