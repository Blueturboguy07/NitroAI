/* Round 9, item 2: every recording under 3.94 MB was uploaded whole and
   NAMED "audio.webm" (chunk.ts, since 6121c9b). Whisper reads the format
   from the name, so a Voice Memos .m4a got 400 "Invalid file format" and the
   user read "NitroAI couldn't read this recording". The upload now carries
   the real extension and MIME type, from the file's first bytes. The bytes
   below are the real first bytes of each container. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkAudioForUpload, sniffAudioExt, uploadFile } from "./chunk";
import { createEngine } from "../engine";

afterEach(() => vi.unstubAllGlobals());

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? p.split("").map((c) => c.charCodeAt(0)) : p)));
const pad = (b: Uint8Array) => {
  const out = new Uint8Array(2048);
  out.set(b);
  return out;
};

/* name, first bytes, the type the browser gives (often ""), the expected upload. */
const CASES: Array<[string, Uint8Array, string, string, string]> = [
  ["Voice Memo.m4a", bytes([0, 0, 0, 0x20], "ftypM4A ", [0, 0, 0, 0], "M4A isommp42"), "audio/x-m4a", "audio.m4a", "audio/mp4"],
  ["lecture.mp4", bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0], "isomiso2avc1mp41"), "video/mp4", "audio.mp4", "video/mp4"],
  ["podcast.mp3", bytes("ID3", [4, 0, 0, 0, 0, 0, 0x23]), "audio/mpeg", "audio.mp3", "audio/mpeg"],
  ["no-tag.mp3", bytes([0xff, 0xfb, 0x90, 0x64]), "", "audio.mp3", "audio/mpeg"],
  ["class.wav", bytes("RIFF", [0x24, 0x08, 0, 0], "WAVEfmt "), "audio/wav", "audio.wav", "audio/wav"],
  ["talk.ogg", bytes("OggS", [0, 2, 0, 0, 0, 0, 0, 0, 0, 0]), "audio/ogg", "audio.ogg", "audio/ogg"],
  ["recording.webm", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), "audio/webm", "audio.webm", "audio/webm"],
  ["lossless.flac", bytes("fLaC", [0, 0, 0, 0x22]), "audio/flac", "audio.flac", "audio/flac"],
];

describe("a whole recording is uploaded with its real name and type", () => {
  for (const [name, head, browserType, filename, type] of CASES) {
    it(`${name} → ${filename} (${type})`, async () => {
      const file = new File([pad(head)], name, { type: browserType });
      const [chunk] = await chunkAudioForUpload(file, { decode: async () => { throw new Error("must not decode a small file"); } });
      expect(chunk.filename).toBe(filename);
      expect(chunk.blob.type).toBe(type);
      expect(chunk.blob.size).toBe(2048);
      expect(chunk.offsetSeconds).toBe(0);
    });
  }

  it("the bytes decide, not a wrong name or type (an M4A renamed .webm is still .m4a)", async () => {
    const file = new File([pad(CASES[0][1])], "renamed.webm", { type: "audio/webm" });
    expect((await uploadFile(file)).filename).toBe("audio.m4a");
  });

  it("with unknown bytes the file name, then the MIME type, decides; with neither it stays audio.webm", async () => {
    const unknown = new Uint8Array(64).fill(7);
    expect((await uploadFile(new File([unknown], "x.ogg"))).filename).toBe("audio.ogg");
    expect((await uploadFile(new Blob([unknown], { type: "audio/x-wav" }))).filename).toBe("audio.wav");
    expect((await uploadFile(new Blob([unknown]))).filename).toBe("audio.webm");
    // ADTS AAC (FF F1) is not MP3.
    expect(sniffAudioExt(bytes([0xff, 0xf1, 0x50, 0x80]))).toBeNull();
  });
});

describe("transcribe() sends that name to the gateway (publik API and your own OpenAI key)", () => {
  for (const provider of ["publik", "openai"] as const) {
    it(`${provider}: a short M4A goes up as audio.m4a, audio/mp4`, async () => {
      const sent: Array<{ name: string; type: string; size: number }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          const file = (init?.body as FormData).get("file") as File;
          sent.push({ name: file.name, type: file.type, size: file.size });
          return new Response(JSON.stringify({ text: "plates move", segments: [] }), { headers: { "content-type": "application/json" } });
        }),
      );
      const engine =
        provider === "publik"
          ? createEngine({ mode: "cloud", provider: "publik", baseUrl: "http://127.0.0.1:41763/api/publik/v1" })
          : createEngine({ mode: "cloud", provider: "openai", apiKey: "sk-test" });
      const tr = await engine.transcribe(new File([pad(CASES[0][1])], "Voice Memo.m4a", { type: "audio/x-m4a" }));
      expect(tr.text).toBe("plates move");
      expect(sent).toEqual([{ name: "audio.m4a", type: "audio/mp4", size: 2048 }]);
    });
  }
});
