import { describe, it, expect } from "vitest";
import { youtubeId, isYoutube } from "./youtube";
import { ingestText } from "./text";
import { ingest } from "./index";

describe("youtubeId", () => {
  it("extracts from watch?v= form", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from watch?v= with extra query params", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from bare-host watch?v= (no www)", () => {
    expect(youtubeId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from the mobile host", () => {
    expect(youtubeId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from youtu.be short links", () => {
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from youtu.be short links with query params", () => {
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ?si=abc123")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from /embed/ form", () => {
    expect(youtubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from /shorts/ form", () => {
    expect(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-youtube urls", () => {
    expect(youtubeId("https://example.com")).toBeNull();
    expect(youtubeId("https://vimeo.com/12345678")).toBeNull();
  });

  it("returns null for malformed or empty input", () => {
    expect(youtubeId("not a url at all")).toBeNull();
    expect(youtubeId("")).toBeNull();
  });
});

describe("isYoutube", () => {
  it("is true for youtube urls of any recognized form", () => {
    expect(isYoutube("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYoutube("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
  });

  it("is false for non-youtube urls", () => {
    expect(isYoutube("https://example.com")).toBe(false);
    expect(isYoutube("not a url")).toBe(false);
  });
});

describe("ingestText", () => {
  it("trims surrounding whitespace", () => {
    const result = ingestText("  \n\nHello world\nmore text  \n\n");
    expect(result.text).toBe("Hello world\nmore text");
  });

  it("derives the title from the first non-empty line", () => {
    const result = ingestText("\n\n  My Title Line  \nBody text follows");
    expect(result.title).toBe("My Title Line");
  });

  it("caps the derived title at 80 chars", () => {
    const longLine = "x".repeat(120);
    const result = ingestText(longLine);
    expect(result.title).toHaveLength(80);
  });

  it("has no title for empty/whitespace-only text", () => {
    const result = ingestText("   \n  \n");
    expect(result.text).toBe("");
    expect(result.title).toBeUndefined();
  });
});

describe("ingest() routing", () => {
  it("routes 'blank' to empty text", async () => {
    const result = await ingest({ kind: "blank" });
    expect(result).toEqual({ text: "" });
  });

  it("routes 'text' through ingestText", async () => {
    const result = await ingest({ kind: "text", text: "  Hello there\nmore  " });
    expect(result.text).toBe("Hello there\nmore");
    expect(result.title).toBe("Hello there");
  });

  it("treats a missing text field as empty input", async () => {
    const result = await ingest({ kind: "text" });
    expect(result.text).toBe("");
    expect(result.title).toBeUndefined();
  });

  it("routes 'audio' to needsTranscription with the blob attached", async () => {
    const blob = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20])], { type: "audio/wav" });
    const result = await ingest({ kind: "audio", file: blob, filename: "lecture.mp3" });
    expect(result.needsTranscription).toBe(true);
    expect(result.text).toBe("");
    expect(result.audio).toBe(blob);
    expect(result.meta?.filename).toBe("lecture.mp3");
  });

  it("rejects 'url' ingestion without a url", async () => {
    await expect(ingest({ kind: "url" })).rejects.toThrow();
  });

  it("rejects 'youtube' ingestion without a url", async () => {
    await expect(ingest({ kind: "youtube" })).rejects.toThrow();
  });

  it("rejects 'pdf' ingestion without a file", async () => {
    await expect(ingest({ kind: "pdf" })).rejects.toThrow();
  });

  it("rejects 'docx' ingestion without a file", async () => {
    await expect(ingest({ kind: "docx" })).rejects.toThrow();
  });
});

/* Every .txt / .md upload used to fail with "No readable content found.":
   CreateNoteModal sends kind "text" with the File, and ingest() read only
   `text`. A failed upload makes no API call, so prod data cannot show who
   hit it. These go through ingest() exactly as the upload does. */
describe("ingest — .txt / .md uploads", () => {
  const upload = (parts: BlobPart[], name: string) => ingest({ kind: "text", file: new File(parts, name), filename: name });

  it("reads a .txt upload's text from the file", async () => {
    const res = await upload(["Lecture 7: The Calvin Cycle\n\nRuBisCO fixes CO2.\n"], "lecture-7.txt");
    expect(res.text).toBe("Lecture 7: The Calvin Cycle\n\nRuBisCO fixes CO2.");
    expect(res.title).toBe("lecture-7");
    expect(res.meta?.filename).toBe("lecture-7.txt");
  });

  it("keeps a .md upload's markdown as it is", async () => {
    const res = await upload(["# Week 3\n\n- **C3** plants\n- `PEP` carboxylase\n"], "week3.md");
    expect(res.text).toBe("# Week 3\n\n- **C3** plants\n- `PEP` carboxylase");
  });

  it("drops a UTF-8 byte-order mark", async () => {
    const res = await upload([new Uint8Array([0xef, 0xbb, 0xbf]), "Résumé of photosynthesis"], "bom.txt");
    expect(res.text).toBe("Résumé of photosynthesis");
  });

  it("reads UTF-16 LE with a BOM (Windows Notepad 'Unicode')", async () => {
    const s = "Stomata öffnen sich nachts";
    const bytes = new Uint8Array(2 + s.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) {
      bytes[2 + i * 2] = s.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = s.charCodeAt(i) >> 8;
    }
    expect((await upload([bytes], "notepad-unicode.txt")).text).toBe(s);
  });

  it("reads bytes that are not UTF-8 as Windows-1252 (Notepad 'ANSI'), not as replacement characters", async () => {
    // "café – naïve" in Windows-1252: é=0xE9, en dash=0x96, ï=0xEF
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65]);
    expect((await upload([bytes], "ansi.txt")).text).toBe("café – naïve");
  });

  it("an empty .txt upload still reads as empty (the pipeline then says so)", async () => {
    expect((await upload([""], "empty.txt")).text).toBe("");
  });

  it("pasted text (kind text, no file) works as before", async () => {
    expect((await ingest({ kind: "text", text: "  pasted  " })).text).toBe("pasted");
  });
});
