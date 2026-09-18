import { describe, expect, it } from "vitest";
import { chunkAudioForUpload, encodeWav, samplesPerChunk, toMono16k, MAX_UPLOAD_BYTES } from "./chunk";

describe("audio chunking", () => {
  it("passes small audio through untouched", async () => {
    const blob = new Blob([new Uint8Array(100)], { type: "audio/mpeg" });
    const chunks = await chunkAudioForUpload(blob, { decode: async () => { throw new Error("must not decode"); } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].blob).toBe(blob);
    expect(chunks[0].offsetSeconds).toBe(0);
  });

  it("downmixes to mono and resamples to 16 kHz", () => {
    const left = new Float32Array([1, 1, 1, 1]);
    const right = new Float32Array([0, 0, 0, 0]);
    const mono = toMono16k({ sampleRate: 32_000, channels: [left, right] }, 16_000);
    expect(mono.length).toBe(2);
    expect(mono[0]).toBeCloseTo(0.5);
  });

  it("encodes a valid 16-bit PCM WAV header", () => {
    const blob = encodeWav(new Float32Array([0, 0.5, -0.5]), 16_000);
    expect(blob.size).toBe(44 + 6);
    expect(blob.type).toBe("audio/wav");
  });

  it("every chunk fits under the cap and offsets line up end to end", async () => {
    const seconds = 400; // 6.7 min at 16 k = 12.8 MB of PCM → several chunks
    const decode = async () => ({ sampleRate: 16_000, channels: [new Float32Array(16_000 * seconds)] });
    const chunks = await chunkAudioForUpload(new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)]), { decode });
    expect(chunks.length).toBe(Math.ceil((16_000 * seconds) / samplesPerChunk(MAX_UPLOAD_BYTES)));
    let expectedOffset = 0;
    for (const c of chunks) {
      expect(c.blob.size).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
      expect(c.blob.size).toBeLessThan(4 * 1024 * 1024);
      expect(c.offsetSeconds).toBeCloseTo(expectedOffset, 5);
      expectedOffset += (c.blob.size - 44) / 2 / 16_000;
    }
    expect(expectedOffset).toBeCloseTo(seconds, 5);
  });
});
