/* Local speech-to-text — the main-thread half.
 *
 * Local mode could never transcribe: audio uploads ended at "add an OpenAI
 * key". This runs Whisper on the user's own machine instead, with no key and
 * no network at transcription time.
 *
 * Two things have to be true before audio can be transcribed offline, and this
 * module owns both:
 *   1. the model is installed on disk (server/whisper.mjs). Normally that
 *      happened during local setup; if the user set local mode up before this
 *      existed — or picked a different Whisper size — it's installed here, on
 *      demand, with progress, rather than failing with "not installed".
 *   2. the audio is decoded to the mono 16 kHz samples Whisper wants (audio.ts)
 * The model itself then runs in worker.ts.
 */

import type { TranscriptResult } from "../engine/types";
import { EngineError } from "../engine/types";
import { localSetupStatus, runWhisperSetup } from "../localSetup";
import { decodeToPcm } from "./audio";
import type { WhisperRequest, WhisperResponse } from "./protocol";

/* Kept in step with DEFAULT_WHISPER_MODEL in server/whisper.mjs. */
export const DEFAULT_WHISPER_MODEL = "whisper-base";

/* Sizes the user can pick in Settings. The labels are the download size, since
   that's the part they're actually choosing between. */
export const WHISPER_MODEL_CHOICES = [
  { id: "whisper-tiny", label: "Tiny", note: "~44 MB · fastest, least accurate" },
  { id: "whisper-base", label: "Base", note: "~80 MB · recommended" },
  { id: "whisper-small", label: "Small", note: "~252 MB · most accurate, slowest" },
];

export interface TranscribeProgress {
  message: string;
  percent?: number;
}

export interface TranscribeOptions {
  model?: string;
  signal?: AbortSignal;
  onProgress?: (p: TranscribeProgress) => void;
}

/* Is the model already on disk? null means there's no local server to ask (a
   plain `npm run dev`, or a static deploy), in which case the worker loads the
   model from Hugging Face instead and there's nothing to install. */
export async function whisperInstalled(model = DEFAULT_WHISPER_MODEL): Promise<boolean | null> {
  const status = await localSetupStatus({ whisperModel: model });
  if (!status) return null;
  return status.whisper?.installed ?? false;
}

/* Install the speech model, reporting progress. Safe to call when it's already
   installed (the server no-ops). */
export async function installWhisper(
  model = DEFAULT_WHISPER_MODEL,
  onProgress?: (p: TranscribeProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await runWhisperSetup(
    (e) =>
      onProgress?.({
        message: e.percent === 100 ? "Speech model ready." : "Downloading the speech model…",
        percent: e.percent,
      }),
    signal,
    model,
  );
}

/* One worker for the app's lifetime: the model costs seconds to load and ~80 MB
   of RAM, and a five-file upload would otherwise pay that five times. */
let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

/* Cancelling means tearing the worker down — there's no way to interrupt a
   generate() already running inside it. The next transcription reloads the
   model, which is the right trade for a cancel the user asked for. */
function killWorker() {
  worker?.terminate();
  worker = null;
}

function runInWorker(
  request: Omit<WhisperRequest, "type" | "id">,
  onProgress?: (p: TranscribeProgress) => void,
  signal?: AbortSignal,
): Promise<TranscriptResult> {
  const w = getWorker();
  const id = nextId++;

  return new Promise<TranscriptResult>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      killWorker();
      reject(new EngineError("Transcription cancelled.", "network"));
    };

    const onMessage = (event: MessageEvent<WhisperResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.({ message: msg.message, percent: msg.percent });
        return;
      }
      cleanup();
      if (msg.type === "error") {
        reject(new EngineError(msg.message, "unknown"));
      } else {
        resolve({ text: msg.text, segments: msg.segments, language: msg.language });
      }
    };

    /* A worker that dies (out of memory on a very long recording, a failed
       wasm load) fires onerror and would otherwise leave this promise pending
       forever — the note would sit on "Transcribing…" with no way out. */
    const onError = (event: ErrorEvent) => {
      cleanup();
      killWorker();
      reject(
        new EngineError(
          event.message
            ? `Local transcription stopped: ${event.message}`
            : "Local transcription stopped unexpectedly. Try a shorter recording.",
          "unknown",
        ),
      );
    };

    function cleanup() {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);

    const payload: WhisperRequest = { type: "transcribe", id, ...request };
    // Transfer the samples rather than copying them — an hour of audio is
    // ~230 MB of Float32.
    w.postMessage(payload, [payload.pcm.buffer]);
  });
}

/* Transcribe audio on this machine. Installs the model first if it isn't there
   yet, so this never fails with "not installed" — it just takes longer once. */
export async function transcribeLocally(
  audio: Blob,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const model = opts.model || DEFAULT_WHISPER_MODEL;
  const { onProgress, signal } = opts;

  onProgress?.({ message: "Checking the speech model…" });
  const status = await localSetupStatus({ whisperModel: model });

  /* No provisioning server: nothing is installed locally and nothing can be, so
     let the worker fetch the model from Hugging Face. That's the `npm run dev`
     path — the packaged app and `npm run serve` always have the server. */
  let modelPath = "";
  if (status) {
    modelPath = `${window.location.origin}/api/local/models/`;
    if (!status.whisper?.installed) {
      try {
        await installWhisper(model, onProgress, signal);
      } catch (err) {
        throw new EngineError(
          err instanceof Error ? err.message : "Couldn't install the speech model.",
          "model_missing",
        );
      }
    }
  }

  onProgress?.({ message: "Preparing audio…" });
  let pcm: Float32Array;
  try {
    pcm = await decodeToPcm(audio);
  } catch (err) {
    /* Bad input or an environment without Web Audio — either way the caller
       wants a clean message, not a raw DOMException. */
    throw new EngineError(
      err instanceof Error ? err.message : "This file's audio couldn't be read.",
      "unsupported",
    );
  }

  return runInWorker({ pcm, model, modelPath }, onProgress, signal);
}
