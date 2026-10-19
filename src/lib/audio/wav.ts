/* WAV helpers for Gemini audio. Gemini's speech models answer with raw
 * 16-bit PCM (or a WAV around it), one clip per podcast line. MP3 clips can
 * simply be glued together; WAV clips can't — each carries its own header —
 * so the podcast is stitched back into one file here. Dependency-free. */

const HEADER_BYTES = 44;

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export const GEMINI_PCM: PcmFormat = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };

export function wavHeader(dataBytes: number, f: PcmFormat): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  const blockAlign = (f.channels * f.bitsPerSample) / 8;
  str(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, f.channels, true);
  view.setUint32(24, f.sampleRate, true);
  view.setUint32(28, f.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, f.bitsPerSample, true);
  str(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

export function pcmToWav(pcm: Uint8Array, f: PcmFormat = GEMINI_PCM): Blob {
  return new Blob([wavHeader(pcm.byteLength, f), pcm as BlobPart], { type: "audio/wav" });
}

/* "audio/L16;codec=pcm;rate=24000" → 24 kHz mono 16-bit. */
export function pcmFormatFromMime(mime: string): PcmFormat {
  const rate = /rate=(\d+)/i.exec(mime);
  const channels = /channels=(\d+)/i.exec(mime);
  return {
    sampleRate: rate ? Number(rate[1]) : GEMINI_PCM.sampleRate,
    channels: channels ? Number(channels[1]) : GEMINI_PCM.channels,
    bitsPerSample: 16,
  };
}

/* Split a RIFF/WAVE file into its format and its PCM bytes, walking the
   chunks rather than assuming a 44-byte header (LIST chunks are common). */
export function parseWav(bytes: Uint8Array): { format: PcmFormat; pcm: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let format: PcmFormat | null = null;
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // Streams sometimes write 0 or 0xFFFFFFFF as the size: take the rest.
      const end = size === 0 || body + size > bytes.byteLength ? bytes.byteLength : body + size;
      return { format: format ?? GEMINI_PCM, pcm: bytes.subarray(body, end) };
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV file has no audio data.");
}

/* Join WAV clips (same format) into one WAV. */
export async function concatWav(parts: Blob[]): Promise<Blob> {
  const decoded = await Promise.all(
    parts.map(async (p) => parseWav(new Uint8Array(await p.arrayBuffer()))),
  );
  const format = decoded[0]?.format ?? GEMINI_PCM;
  const total = decoded.reduce((n, d) => n + d.pcm.byteLength, 0);
  return new Blob([wavHeader(total, format), ...decoded.map((d) => d.pcm as BlobPart)], {
    type: "audio/wav",
  });
}
