/* The one list of document types (D1), as the upload window and ingest()
   use it. Behavior through ingest() and the pipeline is in
   upload-types.test.ts. */
import { describe, expect, it } from "vitest";
import { MAX_TEXT_FILE_BYTES, UNSUPPORTED_FILE_MESSAGE, documentFileProblem, documentKind, looksBinary } from "./fileTypes";

const EXACT =
  "NitroAI reads PDF, Word (.docx, .doc), .txt and .md files. For slides, save them as PDF and upload that.";

describe("fileTypes", () => {
  it("the message names the types that work, word for word", () => {
    expect(UNSUPPORTED_FILE_MESSAGE).toBe(EXACT);
  });

  it("only .pdf, .docx/.doc, .txt and .md have a kind", () => {
    expect(documentKind("a.pdf")).toBe("pdf");
    expect(documentKind("a.DOCX")).toBe("docx");
    expect(documentKind("a.doc")).toBe("docx");
    expect(documentKind("a.txt")).toBe("text");
    expect(documentKind("Notes.MD")).toBe("text");
    expect(documentKind("C:\\Users\\m\\week.3.notes.md")).toBe("text");
    for (const name of ["deck.pptx", "deck.ppt", "sheet.xlsx", "data.csv", "x.markdown", "a.zip", "README", "photo.png", ".txt"]) {
      expect(documentKind(name)).toBeNull();
    }
  });

  it("binary means a NUL byte in the first 8 KB, except after a UTF-16 byte-order mark", () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain text"))).toBe(false);
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(looksBinary(late)).toBe(false);
  });

  it("the upload window's check", async () => {
    const zip = new Uint8Array(1024);
    zip.set([0x50, 0x4b, 0x03, 0x04]);
    expect(await documentFileProblem(new File([zip], "deck.pptx"))).toBe(`NitroAI can't read "deck.pptx". ${EXACT}`);
    expect(await documentFileProblem(new File([zip], "deck.txt"))).toMatch(/^"deck.txt" is not plain text/);
    expect(await documentFileProblem(new File([new Uint8Array(MAX_TEXT_FILE_BYTES + 10).fill(0x61)], "big.md"))).toMatch(/up to 2 MB/);
    expect(await documentFileProblem(new File(["# ok"], "ok.md"))).toBeNull();
    expect(await documentFileProblem(new File(["%PDF-1.7"], "a.pdf"))).toBeNull();
  });
});
