/* Audio decoding for local transcription.
 *
 * Whisper wants exactly one thing: mono 32-bit float samples at 16 kHz. The
 * browser will give us that from an MP3, M4A, WAV, OGG, FLAC or the audio
 * track of an MP4/WebM for free, because decodeAudioData resamples to the
 * decoding context's own sample rate. That's the whole reason transcription
 * runs in the renderer instead of the Node side of the app — doing this in
 * Node would mean shipping ffmpeg. */

export const SAMPLE_RATE = 16000;

type OfflineCtor = typeof OfflineAudioContext;

function offlineAudioContext(): OfflineCtor {
  const ctor =
    (globalThis as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor })
      .OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
  if (!ctor) {
    throw new Error("This browser can't decode audio, so local transcription isn't available here.");
  }
  return ctor;
}

/* Average all channels down to one. Whisper is a mono model; feeding it only
   the left channel would drop half of anything recorded in stereo (a lecturer
   panned to one side, a two-mic interview). */
function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= channels;
  return out;
}

/* Linear resample. Only used on the fallback path — Chromium honours the
   16 kHz context, but Safari has historically clamped OfflineAudioContext to
   the hardware rate, and a 44.1 kHz buffer handed to Whisper transcribes as
   gibberish rather than failing loudly. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

/* Decode any audio/video blob to the mono 16 kHz PCM Whisper expects. */
export async function decodeToPcm(audio: Blob): Promise<Float32Array> {
  const Ctx = offlineAudioContext();
  const bytes = await audio.arrayBuffer();

  let decoded: AudioBuffer;
  try {
    // decodeAudioData detaches the ArrayBuffer, so the fallback below needs
    // its own copy of the bytes.
    decoded = await new Ctx(1, 1, SAMPLE_RATE).decodeAudioData(bytes.slice(0));
  } catch {
    try {
      decoded = await new Ctx(1, 1, 44100).decodeAudioData(bytes.slice(0));
    } catch {
      throw new Error(
        "This file's audio couldn't be read. Try a common format like MP3, M4A, WAV or MP4.",
      );
    }
  }

  const mono = toMono(decoded);
  const pcm = resample(mono, decoded.sampleRate, SAMPLE_RATE);
  if (pcm.length === 0) {
    throw new Error("This file has no audio in it.");
  }
  return pcm;
}
