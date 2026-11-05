/* Round 4 (blind verify of 69b560a). The NUL-in-the-first-8-KB check was not
   enough:
   - a real PDF renamed .txt often has no early NUL (TypeBullet.pdf, 147 KB:
     9 paid calls; 108 of 400 PDFs on the verifier's Mac);
   - a file that starts with FF FE skipped the check (FF FE + .pptx: 5 calls);
   - a Word 97 .doc failed with JSZip's raw "Can't find end of central
     directory";
   - raw library and provider messages reached the user;
   - a 2.05 MB file read "2.0 MB … up to 2 MB"; a pasted title was cut in
     the middle of a word. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingest } from "./index";
import { createNoteFromSources } from "../generation/pipeline";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Engine } from "../engine/types";
import { OpenAIEngine } from "../engine/openai";

afterEach(() => vi.unstubAllGlobals());

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
/* Deterministic "compressed" bytes: every value 0–255, NUL included. */
function noise(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}
/* A PDF like TypeBullet.pdf: a text header and text objects for more than
   8 KB (no NUL there), then compressed streams. */
function realisticPdf(): Uint8Array {
  const objects = Array.from({ length: 160 }, (_, i) => `${i + 1} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`).join("");
  return concat(enc("%PDF-1.5\n%âãÏÓ\n"), enc(objects), enc("200 0 obj\n<< /Length 120000 /Filter /FlateDecode >>\nstream\n"), noise(120_000), enc("\nendstream\nendobj\n%%EOF\n"));
}
/* A zip local file header (PK 03 04, name length at +26, name at +30). */
function zipEntry(name: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const n = enc(name);
  const h = new Uint8Array(30);
  h.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
  h[26] = n.length & 0xff;
  h[27] = n.length >> 8;
  return concat(h, n, data);
}
/* Like the verifier's lecture-slides.pptx: [Content_Types].xml and one ppt/ part. */
function fakePptx(): Uint8Array {
  return concat(zipEntry("[Content_Types].xml", noise(29, 5)), zipEntry("ppt/media/image1.png", noise(110_000)));
}
/* An OLE compound file, as Word 97 saves a .doc. */
function word97(): Uint8Array {
  return concat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), new Uint8Array(19_448));
}

const upload = (bytes: Uint8Array, name: string, kind: "text" | "docx" | "pdf" = "text") =>
  ingest({ kind, file: new File([bytes], name), filename: name });

function countingEngine() {
  const n = { calls: 0 };
  const hit = async () => {
    n.calls++;
    return "# Notes\n\nText.";
  };
  const engine: Engine = {
    mode: "cloud",
    capabilities: () => ({ chat: true, transcription: true, tts: true, embeddings: true }),
    complete: hit,
    structured: async () => {
      n.calls++;
      return {} as never;
    },
    transcribe: async () => {
      n.calls++;
      return { text: "t", segments: [] };
    },
    tts: async () => new Blob(),
    embed: async () => [],
    validate: async () => {},
  };
  return { engine, n };
}

describe("1 — one shared check: known binary signatures and garbled text", () => {
  it("a realistic PDF has no NUL in its first 8 KB (why 69b560a let it through)", () => {
    expect(realisticPdf().subarray(0, 8192).includes(0)).toBe(false);
  });

  for (const name of ["TypeBullet.txt", "TypeBullet.md"]) {
    it(`a PDF renamed ${name.slice(-3)} is refused and told to upload it as a .pdf`, async () => {
      await expect(upload(realisticPdf(), name)).rejects.toThrow(`"${name}" is a PDF file, not a text file. Change its name to end in .pdf, then upload it as a PDF.`);
    });
  }

  it("FF FE + .pptx bytes is refused (the BOM no longer skips the check)", async () => {
    await expect(upload(concat(new Uint8Array([0xff, 0xfe]), fakePptx()), "bom-binary.txt")).rejects.toThrow(/"bom-binary.txt" is a PowerPoint file, not a text file/);
  });

  it("every listed signature is refused as text", async () => {
    const sigs: Array<[string, number[]]> = [
      ["zip", [0x50, 0x4b, 0x03, 0x04]],
      ["ole", [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
      ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ["jpeg", [0xff, 0xd8, 0xff, 0xe0]],
      ["gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
      ["riff", [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]],
      ["ogg", [0x4f, 0x67, 0x67, 0x53, 0x00]],
      ["id3", [0x49, 0x44, 0x33, 0x04, 0x00]],
      ["mp4", [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]],
      ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
      ["rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
      ["gzip", [0x1f, 0x8b, 0x08]],
    ];
    for (const [label, magic] of sigs) {
      // Text after the magic bytes: only the signature can refuse it.
      const bytes = concat(new Uint8Array(magic), enc("plain words ".repeat(400)));
      await expect(upload(bytes, `${label}.txt`), label).rejects.toThrow(/not a text file/);
    }
  });

  it("text that decodes to more than 2% U+FFFD or control characters is refused, UTF-16 too", async () => {
    // UTF-16 LE BOM + noise with no known signature.
    await expect(upload(concat(new Uint8Array([0xff, 0xfe]), noise(20_000, 3)), "utf16-noise.txt")).rejects.toThrow(/not plain text \(it contains binary data\)/);
    // Windows-1252 bytes full of control characters, no NUL anywhere.
    const ctl = enc("Notes ".repeat(500));
    for (let i = 0; i < ctl.length; i += 20) ctl[i] = 0x01;
    await expect(upload(ctl, "controls.md")).rejects.toThrow(/not plain text/);
  });

  it("real text still reads: tabs, CR LF, form feeds, accents, UTF-16, 1% stray characters", async () => {
    const page = "Lecture 7\tCalvin cycle\r\nRuBisCO fixes CO₂ — café.\f\n".repeat(200);
    expect((await upload(enc(page), "lecture.txt")).text).toContain("RuBisCO fixes CO₂");
    const s = "Stomata öffnen sich nachts.\n".repeat(100);
    const u16 = new Uint8Array(2 + s.length * 2);
    u16.set([0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) {
      u16[2 + i * 2] = s.charCodeAt(i) & 0xff;
      u16[3 + i * 2] = s.charCodeAt(i) >> 8;
    }
    expect((await upload(u16, "notepad.txt")).text).toContain("Stomata öffnen");
    const stray = enc("x".repeat(990) + "\u0001".repeat(10));
    expect((await upload(stray, "one-percent.txt")).text.length).toBe(1000);
  });

  it("a renamed PDF in the pipeline makes 0 model calls", async () => {
    const repo = new Repo(memoryStore());
    const { engine, n } = countingEngine();
    await expect(
      createNoteFromSources({ repo, engine, inputs: [{ kind: "text", file: new File([realisticPdf()], "TypeBullet.txt"), filename: "TypeBullet.txt" }] }),
    ).rejects.toThrow(/is a PDF file/);
    expect(n.calls).toBe(0);
  });

  it("a .pdf or .docx whose bytes are something else is refused before its reader runs", async () => {
    await expect(upload(fakePptx(), "slides-as.pdf", "pdf")).rejects.toThrow('"slides-as.pdf" is a PowerPoint file, not a PDF. For slides, save them as PDF and upload that.');
    await expect(upload(fakePptx(), "slides-as.docx", "docx")).rejects.toThrow('"slides-as.docx" is a PowerPoint file, not a Word file.');
    await expect(upload(enc("Lecture 7 notes\n"), "text-as.docx", "docx")).rejects.toThrow('"text-as.docx" is a text file, not a Word file. Change its name to end in .txt, then upload it.');
    await expect(upload(zipEntry("notes/readme.txt", enc("hi")), "plain-zip.docx", "docx")).rejects.toThrow('"plain-zip.docx" is a zip file with no Word document in it');
  });
});

describe("3 — .doc is refused in words", () => {
  const ADVICE = "Save it as .docx (Word: File > Save As), then upload that.";

  it("a real Word 97 .doc gets the Save As advice, never JSZip's message", async () => {
    const err = await upload(word97(), "real-word97.doc", "docx").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(ADVICE);
    expect((err as Error).message).not.toMatch(/central directory|zip/i);
  });

  it("a Word 97 file named .docx gets the same advice", async () => {
    await expect(upload(word97(), "old.docx", "docx")).rejects.toThrow(ADVICE);
  });
});

describe("4 — reader and provider messages are words", () => {
  it("a broken .docx (a zip with Word parts but bad data) says what to do, not the library's words", async () => {
    const broken = concat(zipEntry("[Content_Types].xml", noise(40, 9)), zipEntry("word/document.xml", noise(4000, 11)));
    const err = (await upload(broken, "essay.docx", "docx").catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      'NitroAI couldn\'t read the text in "essay.docx". The file may be damaged or not a Word .docx file. Open it in Word and save it as .docx again (File > Save As), then upload that.',
    );
  });

  it("the provider's 'Invalid file format. Supported formats: …' becomes words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Invalid file format. Supported formats: ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const err = (await new OpenAIEngine("sk-test").transcribe(new Blob([new Uint8Array(100)])).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("NitroAI couldn't read this recording. NitroAI transcribes audio and video files such as MP3, M4A, WAV, MP4 and WEBM.");
  });

  it("WebAudio's 'Unable to decode audio data' becomes words", async () => {
    const engine = new OpenAIEngine("pk_live_test", undefined, {
      provider: "publik",
      baseUrl: "http://127.0.0.1:41763/api/publik/v1",
      audioDecoder: async () => {
        throw new DOMException("Unable to decode audio data", "EncodingError");
      },
    });
    const big = new Blob([new Uint8Array(5 * 1024 * 1024)]);
    const err = (await engine.transcribe(big).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("NitroAI couldn't read this recording. NitroAI transcribes audio and video files such as MP3, M4A, WAV, MP4 and WEBM.");
  });

  it("a .pptx dropped on the audio window is refused before transcription (0 calls)", async () => {
    const repo = new Repo(memoryStore());
    const { engine, n } = countingEngine();
    await expect(
      createNoteFromSources({ repo, engine, inputs: [{ kind: "audio", file: new File([fakePptx()], "slides.pptx"), filename: "slides.pptx" }] }),
    ).rejects.toThrow(/"slides.pptx" is a PowerPoint file, not an audio or video file/);
    expect(n.calls).toBe(0);
  });
});

describe("5 — sizes and titles", () => {
  it("a 2.05 MB file says 2.05 MB, never '2.0 MB … up to 2 MB'", async () => {
    const bytes = new Uint8Array(Math.round(2.05 * 1024 * 1024)).fill(0x61);
    const err = (await upload(bytes, "lecture.txt").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^"lecture.txt" is 2\.05 MB\. NitroAI reads \.txt and \.md files up to 2 MB/);
    const justOver = (await upload(new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61), "x.txt").catch((e: Error) => e)) as Error;
    expect(justOver.message).not.toMatch(/2\.0+ MB/);
  });

  it("a pasted text's title is cut at a word boundary", async () => {
    const line = "Photosynthesis in C4 plants: how PEP carboxylase concentrates carbon dioxide around RuBisCO in bundle sheath cells";
    const { title } = await ingest({ kind: "text", text: `${line}\n\nBody.` });
    expect(title!.length).toBeLessThanOrEqual(80);
    expect(line.startsWith(title!)).toBe(true);
    expect(line[title!.length]).toBe(" ");
  });
});
