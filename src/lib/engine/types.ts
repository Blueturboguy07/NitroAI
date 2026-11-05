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
  /* kind "truncated": the model reported reasoning (thinking) for this
     answer — reasoning tokens in `usage`, or reasoning text in the stream.
     Only then do the messages say the length limit went on "thinking". */
  reasoning?: boolean;
  /* kind "incomplete": why the answer did not end cleanly. The provider's
     finish reason ("content_filter", "error", "refusal" …), or "none" when
     the stream ended with no finish reason at all. */
  finishReason?: string;
  /* kind "incomplete": the host that served the answer, when the stream
     names it (OpenRouter sends "provider" in each chunk). For the report
     only; never shown as the reason. */
  upstreamProvider?: string;
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
      /* The answer did not end cleanly for another reason: the provider's
         content filter stopped it, the provider reported an error, or the
         stream ended with no finish reason (detail.finishReason,
         detail.partialText). Never saved as if it were whole. */
      | "incomplete"
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
export function truncatedError(partialText: string, cappedTo?: number, reasoning = false): EngineError {
  const capped = cappedTo
    ? " publik API lowered the length limit of this request to fit your balance; adding a plan or pack gives it the full limit."
    : "";
  /* "thinking" only when the model reported reasoning tokens. Local models
     and models that do not reason just stopped at the length limit. */
  const message = partialText.trim()
    ? `The answer stopped at the AI's length limit before it was finished.${capped}`
    : reasoning
      ? `The AI used its whole length limit on thinking and wrote no answer.${capped}`
      : `The AI stopped at its length limit before it wrote an answer.${capped}`;
  return new EngineError(message, "truncated", {
    partialText,
    ...(cappedTo ? { cappedTo } : {}),
    ...(reasoning ? { reasoning } : {}),
  });
}

/* The one error every engine raises when an answer does not end with a clean
   "stop" and the reason is not the length limit. On 2026-11-05 the release
   smoke test of NitroAI 0.2.3 made two long notes from the same public-domain
   lecture. In both, one call (a section on the Mac, the merge on Windows)
   ended with finish_reason "content_filter", and the engine took it as whole.
   The Windows note stopped mid-sentence, and the provider's refusal text
   ("The request was rejected because it was considered high risk") was the
   last line of the note. `partialText` is the text before the stop, with the
   refusal text taken out. */
export function incompleteError(partialText: string, finishReason: string, upstreamProvider?: string): EngineError {
  const message = isFilterReason(finishReason)
    ? "The AI provider's safety filter stopped the answer before it was finished."
    : finishReason === "none"
      ? "The answer stopped before it was finished: the connection to the AI ended early."
      : `The answer stopped before it was finished (the AI reported "${finishReason}").`;
  return new EngineError(message, "incomplete", {
    partialText,
    finishReason,
    ...(upstreamProvider ? { upstreamProvider } : {}),
  });
}

/* "content_filter" (OpenAI dialect), "refusal" (Anthropic), "safety" /
   "recitation" / "prohibited_content" (Gemini through OpenRouter). */
export function isFilterReason(reason: string | undefined): boolean {
  return !!reason && /content_filter|refusal|safety|recitation|prohibited|blocklist|spii/i.test(reason);
}

export const isIncomplete = (e: unknown): boolean => e instanceof EngineError && e.kind === "incomplete";
export const isFiltered = (e: unknown): boolean => e instanceof EngineError && e.kind === "incomplete" && isFilterReason(e.detail.finishReason);

/* x-publik-output-capped: "<served>/<asked>" — the cap publik actually served. */
export function cappedToFrom(header: string | null | undefined): number | undefined {
  const m = /^(\d+)\/(\d+)$/.exec((header ?? "").trim());
  return m ? Number(m[1]) : undefined;
}
