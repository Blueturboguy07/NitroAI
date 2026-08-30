/// <reference lib="webworker" />
/* The local speech-to-text engine: Whisper, running in this worker.
 *
 * Transcribing an hour of lecture audio pins a CPU core for minutes. On the
 * main thread that's a frozen window, so all of it — model load and inference —
 * happens here, and the only things crossing the boundary are the decoded
 * samples going in and the transcript coming out.
 *
 * Model weights come from the app's own local server (see server/whisper.mjs),
 * where they were installed once, so a transcription started with the network
 * off still works. The ONNX Runtime .wasm is bundled with the app for the same
 * reason — transformers.js otherwise fetches it from a CDN, which would make
 * "local" mode need the network and leak that it's running.
 */

import {
  env,
  pipeline,
  WhisperTextStreamer,
  type AutomaticSpeechRecognitionPipeline,
  type WhisperTokenizer,
} from "@huggingface/transformers";
import {
  CHUNK_LENGTH_S,
  STRIDE_LENGTH_S,
  WHISPER_SAMPLE_RATE,
  type WhisperRequest,
  type WhisperResponse,
  type WhisperSegment,
} from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/* transformers.js points ONNX Runtime at jsdelivr unless wasmPaths is already
   set, which would make "runs entirely on your device" a lie and break the
   moment the machine is offline. Clearing it hands resolution back to ONNX
   Runtime, whose own default is the .wasm sitting next to this worker — the
   copy the bundler emitted into the app. */
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = undefined;
/* Off by default inside a worker; the whole point here is loading from disk. */
env.allowLocalModels = true;

function post(message: WhisperResponse) {
  ctx.postMessage(message);
}

/* One loaded pipeline, reused across files. Loading the model costs seconds and
   ~80 MB of RAM, and a multi-file upload would otherwise pay that per file. */
let loaded: { model: string; asr: AutomaticSpeechRecognitionPipeline } | null = null;

async function getPipeline(model: string, modelPath: string, id: number) {
  if (loaded?.model === model) return loaded.asr;

  env.localModelPath = modelPath || env.localModelPath;
  /* With no local server there's nothing on disk to load, so fall back to
     fetching from Hugging Face (a dev running `npm run dev` without the
     server). When the server IS there, the files are already installed and
     this never fires. */
  env.allowRemoteModels = !modelPath;

  post({ type: "progress", id, message: "Loading the speech model…" });
  const asr = await pipeline("automatic-speech-recognition", model, {
    /* int8 weights, matching the files server/whisper.mjs installs. */
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    /* WASM, not WebGPU: int8 Whisper on the GPU backend is not dependable
       across the machines this app has to run on, and a wrong transcript is
       worse than a slower one. */
    device: "wasm",
    progress_callback: (p: { status?: string; progress?: number }) => {
      if (p.status === "progress" && typeof p.progress === "number") {
        post({
          type: "progress",
          id,
          message: "Loading the speech model…",
          percent: Math.round(p.progress),
        });
      }
    },
  });
  loaded = { model, asr };
  return asr;
}

/* Whisper emits "no speech" markers and repeated hallucinated filler on silence.
   Dropping empty segments keeps those out of the note's grounding text. */
type PipelineChunk = { timestamp: [number, number | null]; text: string };

function toSegments(chunks: PipelineChunk[] | undefined): WhisperSegment[] {
  if (!chunks) return [];
  return chunks
    .filter((c) => c.text?.trim())
    .map((c) => ({
      start: c.timestamp?.[0] ?? 0,
      end: c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0,
      text: c.text.trim(),
    }));
}

async function transcribe(req: WhisperRequest) {
  const { id, pcm, model, modelPath } = req;
  const asr = await getPipeline(model, modelPath, id);

  /* transformers.js runs one generate() per 30-second window of audio, and the
     only way to see inside that is Whisper's own streamer: on_finalize fires
     once per window, and on_chunk_start reports where in the current window the
     model is, in seconds. Together they give real progress. Without it a
     45-minute recording sits on one unmoving message for ten minutes and looks
     hung. */
  const duration = pcm.length / WHISPER_SAMPLE_RATE;
  const jump = CHUNK_LENGTH_S - 2 * STRIDE_LENGTH_S;
  let windowsDone = 0;
  let reported = 0;

  const report = (seconds: number) => {
    if (duration <= 0) return;
    const percent = Math.min(99, Math.round((seconds / duration) * 100));
    // Windows overlap, so a raw reading can step backwards; never show that.
    if (percent <= reported) return;
    reported = percent;
    post({ type: "progress", id, message: "Transcribing audio…", percent });
  };

  const streamer = new WhisperTextStreamer(asr.tokenizer as unknown as WhisperTokenizer, {
    on_chunk_start: (time: number) => report(windowsDone * jump + time),
    on_finalize: () => {
      windowsDone++;
      report(windowsDone * jump);
    },
  });

  post({ type: "progress", id, message: "Transcribing audio…", percent: 0 });
  const output = await asr(pcm, {
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    streamer,
  });

  const result = Array.isArray(output) ? output[0] : output;
  post({
    type: "result",
    id,
    text: (result.text ?? "").trim(),
    segments: toSegments(result.chunks as never),
  });
}

/* Requests run one at a time. A transformers.js pipeline can't have two
   generate() calls in flight against it, and a multi-file upload is exactly the
   case that would try. */
let queue: Promise<void> = Promise.resolve();

ctx.addEventListener("message", (event: MessageEvent<WhisperRequest>) => {
  const req = event.data;
  if (req?.type !== "transcribe") return;
  queue = queue.then(() =>
    transcribe(req).catch((err) => {
      post({
        type: "error",
        id: req.id,
        message: err instanceof Error ? err.message : "Local transcription failed.",
      });
    }),
  );
});
