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
  maxTokens?: number;
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

/* One entry in a provider's model list (Settings → model picker). */
export interface ModelInfo {
  id: string;
  label?: string;
}

export interface EngineCapabilities {
  chat: boolean;
  transcription: boolean;
  tts: boolean;
  embeddings: boolean;
  /* Can read page images through readDocument() — the OCR fallback for
     scanned PDFs and image-only DOCX. Optional so engines (and test fakes)
     that predate it read as "no". */
  vision?: boolean;
  /* readDocument() also takes a whole PDF as-is (Gemini, Anthropic), so its
     pages needn't be rendered to images first. */
  visionPdf?: boolean;
}

/* One input to readDocument(): a page image (image/png, image/jpeg…) or, on
   engines with `visionPdf`, a whole PDF (application/pdf). */
export interface DocumentPart {
  mimeType: string;
  data: Blob;
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

  /* Read document pages visually and return their text in reading order.
     Used when text extraction finds nothing (scanned PDFs, slides exported
     as images). Present only on engines whose capabilities().vision is true;
     check with supportsTask(engine, "vision"). */
  readDocument?(parts: DocumentPart[], signal?: AbortSignal): Promise<string>;

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
      | "unknown" = "unknown",
    readonly detail: EngineErrorDetail = {},
  ) {
    super(message);
    this.name = "EngineError";
  }
}
