/* Engine abstraction. CloudEngine (OpenAI/Anthropic) and LocalEngine (Ollama /
   whisper.cpp / Kokoro) both implement this identical interface, so generation
   and UI code never branch on which one is active. */

import type { Provider } from "../types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  system?: string;
  messages: ChatMessage[];
  /* Task hint lets the router pick a cheap vs strong model tier. */
  tier?: "fast" | "strong";
  temperature?: number;
  /* The output cap. On a reasoning model it covers the model's thinking AND
     the answer, so it must leave room for both (see generation/index.ts). */
  maxTokens?: number;
  /* How hard a reasoning model thinks before it answers. Sent as
     `reasoning_effort` on the publik path only (publik's tiers are reasoning
     models and default to "medium" on balanced); other providers ignore it. */
  reasoningEffort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

/* JSON-schema-constrained structured output. Providers use their native strict
   modes (OpenAI Structured Outputs, Anthropic tool/output schema). */
export interface StructuredOptions<_T> extends CompletionOptions {
  schema: Record<string, unknown>;
  schemaName: string;
}

export type TokenHandler = (delta: string) => void;

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
}

export interface TtsOptions {
  voice: string;
  /* Provider-agnostic; local Kokoro maps these to its voice ids. */
  format?: "mp3" | "wav";
  signal?: AbortSignal;
}

export interface EngineCapabilities {
  chat: boolean;
  transcription: boolean;
  tts: boolean;
  embeddings: boolean;
}

export interface Engine {
  readonly mode: "local" | "cloud";
  readonly provider?: Provider;
  capabilities(): EngineCapabilities;

  /* Streaming free-form completion. Returns the full text; streams deltas. */
  complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string>;

  /* Schema-constrained structured output, validated & parsed. */
  structured<T>(opts: StructuredOptions<T>): Promise<T>;

  /* Speech-to-text. Blob is audio/video. */
  transcribe(audio: Blob, signal?: AbortSignal): Promise<TranscriptResult>;

  /* Text-to-speech. Returns audio bytes. */
  tts(text: string, opts: TtsOptions): Promise<Blob>;

  /* Vector embeddings for RAG. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;

  /* Cheap liveness/credentials check. Throws on failure. */
  validate(): Promise<void>;
}

/* Extra, provider-specific facts about an error the UI may act on. */
export interface EngineErrorDetail {
  /* publik API 402: the ONE link the app renders (claim page while anonymous,
     add-credit page once claimed). */
  topUpUrl?: string | null;
  /* publik API "anonymous" | "claimed" — picks the button label. */
  claimState?: string;
  /* publik API 429 daily_cap_reached / week_budget_reached. */
  retryAfterSeconds?: number;
  /* publik API 401 key_revoked with reprovision:false — the install was
     removed from the user's account; the app must not re-mint on its own. */
  disconnected?: boolean;
  /* kind "truncated": the answer stopped at the output cap (OpenAI
     finish_reason "length", Anthropic stop_reason "max_tokens", Ollama
     done_reason "length"). `partialText` is what did arrive — "" when a
     reasoning model spent the whole cap thinking. */
  partialText?: string;
  /* publik API lowered the cap to fit the balance (x-publik-output-capped
     "<served>/<asked>"): the cap that was actually served. */
  cappedTo?: number;
}

/* Raised by engines for user-actionable failures (bad key, quota, model
   missing) so the UI can show a clean message instead of a stack trace. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "auth"
      | "quota"
      | "rate_limit"
      | "network"
      | "model_missing"
      | "unsupported"
      /* publik API: out of credit or over a spend cap. Never retried. */
      | "credit"
      /* The answer hit the output cap before it was finished (detail.partialText). */
      | "truncated"
      | "unknown" = "unknown",
    readonly detail: EngineErrorDetail = {},
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/* The one error every engine raises when an answer hits the output cap.
   A reasoning model (publik's tiers) counts its thinking against the same
   cap, so "nothing came back" is a real outcome, not a corner case: on
   2026-09-30 two NitroAI note sections spent all 4,000 of their tokens on
   reasoning and the app saved an empty note. Callers decide what to do with
   the partial text; this message is for the ones that just show it. */
export function truncatedError(partialText: string, cappedTo?: number): EngineError {
  const capped = cappedTo
    ? " publik API lowered the length limit of this request to fit your balance; adding a plan or pack gives it the full limit."
    : "";
  const message = partialText.trim()
    ? `The answer stopped at the AI's length limit before it was finished.${capped}`
    : `The AI used its whole length limit on thinking and wrote no answer.${capped}`;
  return new EngineError(message, "truncated", { partialText, ...(cappedTo ? { cappedTo } : {}) });
}

/* x-publik-output-capped: "<served>/<asked>" — the cap publik actually served. */
export function cappedToFrom(header: string | null | undefined): number | undefined {
  const m = /^(\d+)\/(\d+)$/.exec((header ?? "").trim());
  return m ? Number(m[1]) : undefined;
}
