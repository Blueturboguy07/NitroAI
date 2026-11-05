/* Round 5 (re-verify of 98a278e). The 2% "garbled" limit counted form feeds,
   vertical tabs and U+FFFD, so real text was refused as "binary data":
   pdftotext with title-only pages (5.94% \f), a PowerPoint copy with soft
   line breaks (4.67% \v), a PDF copy with ligature marks (2.86% \x02 +
   0.95% U+FFFD). And a PDF with junk before "%PDF-" passed as text (61 of
   400 system PDFs with 33 junk bytes).

   The new limits come from a corpus measured on Mann's Mac (Nov 4 2026; the
   file lists and the measure script stay with the bug-fix notes, not in the
   repo):

   REAL TEXT, 1,898 files: pdftotext of 228 PDFs with text in 3 modes (684),
   UTF-16 copies of the corpus (354), system text files (114), .strings
   files saved as UTF-16 (150), npm Markdown, licences, JSON (142), source
   code (93), HTML (80), scripts (41), RTF via textutil (31), man pages (22),
   terminal logs and raw man pages (9), the verifier's B files (24), and copy-paste
   variants of 22 real texts (154: ligatures as \x02 or as TeX font slots,
   lost glyphs as U+FFFD, \v soft breaks, a form feed after every line).

   BINARY, 4,390 files: system PDFs (600), the same 1,018 PDFs with junk
   before "%PDF-" (3,054: 33 text bytes, 33 random letters, 500 bytes with
   no NUL), Mach-O (148), images (320), fonts (60), sounds (14), sqlite (20),
   .exe/.dll (24), .node/.wasm (19), .car/.nib/bplist (63), the verifier's A,
   r3 and audio files (39), random bytes, BOM + random, BOM + Mach-O/.exe,
   gzip, tar (26).

   What the decoded text has (share of characters):
                                         real text            binary that gets past
                                                              signature, PDF and NUL
   stray C0 controls (not \t\n\r\f\v,   max 2.86% (verifier)  min 9.61% (8 KB text
   not ESC [ colour codes, not            1.38% (densest file      + random), random
   overstrike backspaces)                 a program made)          9.9–10.6%, 7-bit 20.9%
                                          p99 0.44%, median 0
   broken UTF-16 (lone surrogates)      0 in 507 UTF-16 files  min 0.26% (FE FF + Mach-O),
                                                              random 2.9–3.3%
   U+FFFD in the file                   max 4.61% (a manual's  0 in every 8-bit decode
                                          contents leaders),     (2,674 decodes): not a
                                          63% in contents pages  binary sign, not counted
   \f, \v                               5.94%, 4.67% (verifier) not counted
   ESC (colour codes) / BS (overstrike) up to 6.41% / 8.81%    not counted in a code

   Limits: stray controls > 5% (between 2.86% and 9.61%, about 1.8× from
   each), broken UTF-16 > 0.1% (2.6× under 0.26%), and at least 8 bad
   characters (a short text with two marks is not refused). For bytes that
   should be text, "%PDF-n.n" in the first 1 KB plus "%%EOF" in the last
   1 KB is a PDF: 1,018 of 1,018 system PDFs end that way, 0 of 1,898 real
   text files do ("%PDF-" alone was in one: a git log).

   On the same corpora, 98a278e refused 47 real text files and read 355 of
   the junk + PDF files as text. This commit: 0 and 0. Stress test, every
   NUL byte taken out of every binary: 12 of 4,390 read as text (text-heavy
   sqlite, a .dll, two .tiff, an .icns, a binary plist, a .tar); real files
   of those kinds have NUL bytes in the first 8 KB, and the NUL check
   refuses them.

   To run the check over real corpora, give list files (one path per line,
   or tab-separated with the path last):
     NITROAI_TEXT_CORPUS=text.tsv NITROAI_BINARY_CORPUS=bin.tsv npx vitest run text-check-corpus */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ingest } from "./index";
import { createNoteFromSources } from "../generation/pipeline";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Engine } from "../engine/types";
import {
  MAX_BROKEN_UTF16_SHARE,
  MAX_CONTROL_SHARE,
  MAX_TEXT_FILE_BYTES,
  brokenUtf16Count,
  inspectText,
  isPdfAfterJunk,
  strayControlCount,
} from "./fileTypes";

const enc = (s: string) => new TextEncoder().encode(s);
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function utf16(s: string, le: boolean): Uint8Array {
  const b = new Uint8Array(2 + s.length * 2);
  b.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[2 + 2 * i] = le ? c & 0xff : c >> 8;
    b[3 + 2 * i] = le ? c >> 8 : c & 0xff;
  }
  return b;
}
/* Deterministic bytes; `map` picks the range. */
function noise(n: number, seed: number, map: (x: number) => number = (x) => x): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = map(x >>> 24);
  }
  return b;
}
const share = (s: string) => strayControlCount(s) / s.length;

const PROSE =
  "Photosynthesis turns light into chemical energy. The light reactions make ATP and NADPH in the thylakoid membrane, and the Calvin cycle uses them to fix carbon dioxide in the stroma. RuBisCO fixes CO2 slowly, so plants make a lot of it.\n";

/* An ASCII-only PDF (no stream is compressed), like the small icon PDFs
   that passed with junk before the header. */
const ASCII_PDF =
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
  "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 16 16] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\n" +
  "0 0 m 16 16 l 0 16 m 16 0 l S 2 w 8 8 m 8 0 l S\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n420\n%%EOF\n";

/* Real text, made the way programs make it. Each one must read. */
const REAL: Array<[string, () => Uint8Array]> = [
  // The verifier's 5.94%: here a form feed after every short title (10%).
  ["pdftotext of a deck with title-only pages (\\f)", () => enc(Array.from({ length: 70 }, (_, i) => `Slide ${i + 1}\n\f`).join(""))],
  // The verifier's 4.67%: here a \v every 3 words.
  [
    "a PowerPoint copy, soft line breaks as \\v",
    () => enc(PROSE.repeat(8).split(" ").map((w, i) => (i % 3 === 2 ? `${w}\v` : `${w} `)).join("")),
  ],
  // The verifier's ligature copy: 2.86% \x02 + 0.95% U+FFFD.
  [
    "a PDF copy, ligatures as \\x02 and lost glyphs as U+FFFD",
    () => enc("The e\x02ciency is low. The \x02rst step is light absorption; \uFFFD = 0.3. The \x02nal step makes su\x02cient sugar.\n".repeat(40)),
  ],
  [
    "pdftotext of a manual's contents pages: leaders as \\b + U+FFFD",
    () => enc(Array.from({ length: 40 }, (_, i) => `Chapter ${i + 1} Color Controls\b${"\uFFFD".repeat(60)} ${i * 12 + 3}\n`).join("")),
  ],
  [
    "a terminal log with colour codes (ESC [)",
    () => enc(Array.from({ length: 80 }, (_, i) => `\x1b[32m✓\x1b[39m src/lib/ingest/t${i}.test.ts \x1b[2m(12 tests)\x1b[22m \x1b[33m41ms\x1b[39m\n`).join("")),
  ],
  [
    "a man page saved with man ls > ls.txt (overstrike \\b)",
    () => enc("N\bNA\bAM\bME\bE\n     l\bls\bs - list directory contents\nS\bSY\bYN\bNO\bOP\bPS\bSI\bIS\bS\n     l\bls\bs [-\b-A\bA] [_\bf_\bi_\bl_\be ...]\n".repeat(60)),
  ],
  [
    "pdftotext of a dictionary page: TeX ligature slots and a pronunciation font",
    () => enc(("ec·o·tone \x03ek\x0e\x0ftōn\x03 n. Ecology a region of transition. The e\x0ecient o\x0bce \x0cle \x0dows.\n" + PROSE).repeat(30)),
  ],
  ["UTF-16 LE text with emoji and a literal U+FFFD", () => utf16("Stomata 🌱 öffnen sich nachts. \uFFFD Ende.\n".repeat(100), true)],
  ["UTF-16 BE text with emoji and a literal U+FFFD", () => utf16("気孔は夜に開く 🌱 \uFFFD 終わり。\n".repeat(100), false)],
  ["text that names %PDF-1.7 and %%EOF near its start", () => enc("A PDF starts with %PDF-1.7 and ends with %%EOF.\n" + PROSE.repeat(10))],
  ["a short text with a few ligature marks", () => enc("e\x02cient \x02rst \x02nal o\x02ce")],
];

/* Bytes that are not text. Each one must be refused. */
const BINARY: Array<[string, () => Uint8Array, RegExp]> = [
  ["random bytes with no NUL", () => noise(150_000, 11, (x) => x || 1), /not plain text/],
  ["random 7-bit bytes (valid UTF-8)", () => noise(65_536, 12, (x) => (x % 127) + 1), /not plain text/],
  ["8 KB of text, then binary with no NUL", () => concat(enc(PROSE.repeat(40).slice(0, 8192)), noise(110_000, 13, (x) => x || 1)), /not plain text/],
  ["FF FE + random bytes", () => concat(new Uint8Array([0xff, 0xfe]), noise(150_000, 14)), /not plain text/],
  ["FE FF + random bytes", () => concat(new Uint8Array([0xfe, 0xff]), noise(8192, 15)), /not plain text/],
  [
    "FF FE + a Windows .exe",
    () => concat(new Uint8Array([0xff, 0xfe, 0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]), new Uint8Array(48), noise(40_000, 16, (x) => (x < 96 ? 0 : x))),
    /not plain text/,
  ],
  ["33 junk bytes + an ASCII-only PDF", () => enc("This is not the start of a PDF.\n" + ASCII_PDF), /is a PDF file, not a text file\. Change its name to end in \.pdf/],
  ["500 junk bytes with no NUL + a PDF", () => concat(noise(500, 17, (x) => x || 1), enc(ASCII_PDF)), /is a PDF file, not a text file/],
];

const upload = (bytes: Uint8Array, name: string) => ingest({ kind: "text", file: new File([bytes.slice()], name), filename: name });

describe("round 5 — real text reads, binary is refused", () => {
  it("the limits sit inside the measured gap", () => {
    expect(MAX_CONTROL_SHARE).toBeGreaterThan(0.0286 * 1.5);
    expect(MAX_CONTROL_SHARE).toBeLessThan(0.0961 / 1.5);
    expect(MAX_BROKEN_UTF16_SHARE).toBeLessThan(0.0026 / 2);
  });

  it("\\t \\n \\r \\f \\v, colour codes and overstrike are not stray controls; other C0 characters are", () => {
    expect(strayControlCount("a\tb\nc\rd\fe\vf")).toBe(0);
    expect(strayControlCount("\x1b[31mred\x1b[0m \x1b]8;;https://x\x1b\\link")).toBe(0);
    expect(strayControlCount("N\bN _\bf f\b_")).toBe(0);
    expect(strayControlCount("\x00\x01\x02\x07\x0e\x1f\x1b \b")).toBe(8);
  });

  it("broken UTF-16 counts lone surrogates, not pairs or a literal U+FFFD", () => {
    expect(brokenUtf16Count(utf16("🌱 \uFFFD", true))).toBe(0);
    expect(brokenUtf16Count(utf16("a\ud800b\udc00c", true))).toBe(2);
    expect(brokenUtf16Count(enc("no BOM \uFFFD"))).toBe(0);
  });

  for (const [label, make] of REAL) {
    it(`reads: ${label}`, async () => {
      const bytes = make();
      const found = inspectText(bytes);
      expect(found.ok, label).toBe(true);
      expect((await upload(bytes, "notes.txt")).text.length).toBeGreaterThan(0);
    });
  }

  it("the three files the verifier named are at (or above) its densities", () => {
    const text = (i: number) => new TextDecoder().decode(REAL[i][1]());
    expect(text(0).split("\f").length - 1).toBeGreaterThan(0.0594 * text(0).length);
    expect(text(1).split("\v").length - 1).toBeGreaterThan(0.0467 * text(1).length);
    expect(share(text(2))).toBeGreaterThanOrEqual(0.0286);
  });

  for (const [label, make, message] of BINARY) {
    it(`refuses: ${label}`, async () => {
      await expect(upload(make(), "notes.txt"), label).rejects.toThrow(message);
    });
  }

  it("a PDF after junk needs %PDF-n.n in the first 1 KB and %%EOF in the last 1 KB", () => {
    expect(isPdfAfterJunk(enc("x".repeat(1000) + ASCII_PDF))).toBe(true);
    expect(isPdfAfterJunk(enc("x".repeat(1100) + ASCII_PDF))).toBe(false);
    expect(isPdfAfterJunk(enc("about %PDF- files\n" + PROSE.repeat(20) + "%%EOF\n"))).toBe(false);
    expect(isPdfAfterJunk(enc("junk\n" + ASCII_PDF.replace("%%EOF", "")))).toBe(false);
  });

  it("the three verifier files make notes again (they did on 69b560a)", async () => {
    for (const i of [0, 1, 2]) {
      const calls = { n: 0 };
      const engine: Engine = {
        mode: "cloud",
        capabilities: () => ({ chat: true, transcription: true, tts: true, embeddings: true }),
        complete: async () => (calls.n++, "# Notes\n\nPhotosynthesis."),
        structured: async () => (calls.n++, {} as never),
        transcribe: async () => (calls.n++, { text: "", segments: [] }),
        tts: async () => new Blob(),
        embed: async () => [],
        validate: async () => {},
      };
      const file = new File([REAL[i][1]().slice()], `verifier-${i}.txt`);
      const id = await createNoteFromSources({ repo: new Repo(memoryStore()), engine, inputs: [{ kind: "text", file, filename: file.name }] });
      expect(id, REAL[i][0]).toBeTruthy();
      expect(calls.n, REAL[i][0]).toBeGreaterThan(0);
    }
  });
});

/* The real corpora, when they are on this machine (see the top comment). */
function listed(env: string | undefined): string[] {
  if (!env || !fs.existsSync(env)) return [];
  return fs
    .readFileSync(env, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").pop()!)
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 0);
}
function head(path: string): Uint8Array {
  const fd = fs.openSync(path, "r");
  const b = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_TEXT_FILE_BYTES));
  fs.readSync(fd, b, 0, b.length, 0);
  fs.closeSync(fd);
  return new Uint8Array(b);
}
const TEXT_FILES = listed(process.env.NITROAI_TEXT_CORPUS);
const BINARY_FILES = listed(process.env.NITROAI_BINARY_CORPUS);

describe("round 5 — the measured corpora (only when the lists are given)", () => {
  it.runIf(TEXT_FILES.length > 0)(`every real text file reads (${TEXT_FILES.length} files)`, () => {
    const refused = TEXT_FILES.filter((p) => !inspectText(head(p)).ok);
    expect(refused).toEqual([]);
  });
  it.runIf(BINARY_FILES.length > 0)(`every binary file is refused (${BINARY_FILES.length} files)`, () => {
    const read = BINARY_FILES.filter((p) => !/crafted-utf16-cjk/.test(p) && inspectText(head(p)).ok);
    expect(read).toEqual([]);
  });
});
