/* Client-side audio chunking for publik API transcription.
 *
 * The gateway sits behind a 4.5 MB request cap (contract §1: apps keep
 * requests under 4 MB). A lecture recording is usually bigger, so instead of
 * refusing it we decode it in the renderer (WebAudio), downmix to 16 kHz mono
 * — all Whisper listens to anyway — and cut it into 16-bit WAV pieces that
 * each fit under the cap (~2 minutes per piece). Each piece is transcribed on
 * its own and the segments are shifted back by the piece's offset.
 *
 * Dependency-free. The decoder is injectable so the arithmetic is testable
 * under Node, where there is no AudioContext. */

export interface AudioChunk {
  blob: Blob;
  filename: string;
  /* Where this chunk starts in the original recording, in seconds. */
  offsetSeconds: number;
}

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export type AudioDecoder = (audio: Blob) => Promise<DecodedAudio>;

/* 4 MB minus headroom for the multipart envelope around the file part. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 - 64 * 1024;
export const TARGET_SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44;

/* Decode with the browser's WebAudio decoder (any container Chromium plays:
   mp3, m4a, wav, webm, ogg, mp4 audio tracks). */
export const browserDecode: AudioDecoder = async (audio) => {
  const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = w.AudioContext ?? w.webkitAudioContext;
  if (!AC) throw new Error("This browser can't decode audio for chunking.");
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await audio.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i));
    return { sampleRate: decoded.sampleRate, channels };
  } finally {
    void ctx.close();
  }
};

/* Average every channel into one, then resample by linear interpolation. */
export function toMono16k(decoded: DecodedAudio, targetRate = TARGET_SAMPLE_RATE): Float32Array {
  const { sampleRate, channels } = decoded;
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  if (sampleRate === targetRate) return mono;
  const outLen = Math.max(1, Math.round((n * targetRate) / sampleRate));
  const out = new Float32Array(outLen);
  const step = sampleRate / targetRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = mono[Math.min(j, n - 1)];
    const b = mono[Math.min(j + 1, n - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/* 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(buffer);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/* Samples per chunk so that header + PCM stays under maxBytes. */
export function samplesPerChunk(maxBytes: number): number {
  return Math.max(1, Math.floor((maxBytes - WAV_HEADER_BYTES) / 2));
}

/* The entry point. Small files pass through untouched (whatever container
   they came in); large ones come back as ≤ maxBytes WAV pieces. */
export async function chunkAudioForUpload(
  audio: Blob,
  { maxBytes = MAX_UPLOAD_BYTES, decode = browserDecode, targetRate = TARGET_SAMPLE_RATE }: {
    maxBytes?: number;
    decode?: AudioDecoder;
    targetRate?: number;
  } = {},
): Promise<AudioChunk[]> {
  if (audio.size <= maxBytes) return [{ blob: audio, filename: "audio.webm", offsetSeconds: 0 }];
  const mono = toMono16k(await decode(audio), targetRate);
  const per = samplesPerChunk(maxBytes);
  const chunks: AudioChunk[] = [];
  for (let start = 0; start < mono.length; start += per) {
    const slice = mono.subarray(start, Math.min(start + per, mono.length));
    chunks.push({
      blob: encodeWav(slice, targetRate),
      filename: `chunk-${chunks.length + 1}.wav`,
      offsetSeconds: start / targetRate,
    });
  }
  return chunks;
}
