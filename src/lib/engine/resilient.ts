/* Wraps any Engine with exponential backoff on rate-limit (HTTP 429) and
   transient network errors. A low tokens-per-minute key then just runs slower
   instead of hard-failing — combined with chunked generation, documents of any
   size complete. Streaming ops only retry on pre-stream failures (429 is
   immediate), so tokens are never double-emitted. */

import type {
  Engine,
  CompletionOptions,
  StructuredOptions,
  TokenHandler,
  TranscriptResult,
  TtsOptions,
} from "./types";
import { EngineError } from "./types";

const DELAYS_MS = [3000, 8000, 20000, 40000];

function retryable(e: unknown): boolean {
  return e instanceof EngineError && (e.kind === "rate_limit" || e.kind === "network");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new EngineError("Cancelled", "network"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new EngineError("Cancelled", "network"));
      },
      { once: true },
    );
  });
}

async function withBackoff<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!retryable(e) || attempt === DELAYS_MS.length) throw e;
      await sleep(DELAYS_MS[attempt], signal);
    }
  }
  throw last;
}

export function resilient(engine: Engine): Engine {
  return {
    mode: engine.mode,
    provider: engine.provider,
    capabilities: () => engine.capabilities(),
    complete: (opts: CompletionOptions, onToken?: TokenHandler) =>
      withBackoff(() => engine.complete(opts, onToken), opts.signal),
    structured: <T>(opts: StructuredOptions<T>) =>
      withBackoff(() => engine.structured(opts), opts.signal),
    transcribe: (audio: Blob, signal?: AbortSignal): Promise<TranscriptResult> =>
      withBackoff(() => engine.transcribe(audio, signal), signal),
    tts: (text: string, opts: TtsOptions) =>
      withBackoff(() => engine.tts(text, opts), opts.signal),
    embed: (texts: string[], signal?: AbortSignal) =>
      withBackoff(() => engine.embed(texts, signal), signal),
    validate: () => engine.validate(),
  };
}
