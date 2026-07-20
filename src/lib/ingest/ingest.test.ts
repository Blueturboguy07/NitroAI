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
    const blob = new Blob(["fake audio bytes"], { type: "audio/mpeg" });
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
