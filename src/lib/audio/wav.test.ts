import { describe, expect, it } from "vitest";
import { concatWav, parseWav, pcmFormatFromMime, pcmToWav } from "./wav";
import { synthesizePodcastAudio } from "../generation";
import type { Engine } from "../engine/types";
import type { Podcast } from "../types";

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe("wav helpers", () => {
  it("round-trips PCM through a WAV header", async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const { format, pcm: out } = parseWav(await bytes(pcmToWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 })));
    expect(format).toEqual({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect([...out]).toEqual([1, 2, 3, 4]);
  });

  it("reads the sample rate from Gemini's PCM mime type", () => {
    expect(pcmFormatFromMime("audio/L16;codec=pcm;rate=24000").sampleRate).toBe(24000);
    expect(pcmFormatFromMime("audio/L16").sampleRate).toBe(24000);
  });

  it("joins clips under one header", async () => {
    const joined = await concatWav([pcmToWav(new Uint8Array([1, 2])), pcmToWav(new Uint8Array([3, 4, 5, 6]))]);
    const raw = await bytes(joined);
    expect(raw.byteLength).toBe(44 + 6);
    expect([...parseWav(raw).pcm]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("synthesizePodcastAudio", () => {
  const podcast: Podcast = {
    id: "p",
    noteId: "n",
    length: "short",
    createdAt: 0,
    script: [
      { speaker: "host", text: "Hi", spoken: "Hi" },
      { speaker: "guest", text: "Hello", spoken: "Hello" },
    ],
  };
  const engineWith = (tts: Engine["tts"]) => ({ tts }) as unknown as Engine;

  it("stitches WAV lines (Gemini) into one playable WAV", async () => {
    const blob = await synthesizePodcastAudio(engineWith(async () => pcmToWav(new Uint8Array([7, 7]))), podcast);
    expect(blob.type).toBe("audio/wav");
    expect([...parseWav(await bytes(blob)).pcm]).toEqual([7, 7, 7, 7]);
  });

  it("keeps gluing MP3 lines (OpenAI) as before", async () => {
    const blob = await synthesizePodcastAudio(
      engineWith(async () => new Blob([new Uint8Array([9])], { type: "audio/mpeg" })),
      podcast,
    );
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe(2);
  });
});
