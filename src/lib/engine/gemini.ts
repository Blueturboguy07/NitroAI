/* Google Gemini implementation of the Engine interface. Cloud mode, provider
   "gemini". Talks to the Gemini API (generativelanguage.googleapis.com)
   directly via `fetch` with the user's own AI Studio key (AIza…) — no SDK.

   Unlike Anthropic, one Gemini key carries every line the app uses:
     • chat / notes        — models.streamGenerateContent (SSE)
     • structured output   — generateContent + responseJsonSchema
     • transcription       — generateContent with the audio inline
     • podcast voices      — the Gemini TTS models (24 kHz PCM → WAV)
     • embeddings          — gemini-embedding-001
     • document reading    — scanned PDFs / page images inline (OCR fallback)

   Gemini model ids churn fast (2.0 was shut down in 2026 and new 3.x point
   releases land every few weeks), so no chat model is hardcoded as the
   default: with nothing chosen in Settings, the newest stable Flash /
   Flash-Lite this key can list is picked once per engine. */

import type {
  ChatMessage,
  CompletionOptions,
  DocumentPart,
  Engine,
  EngineCapabilities,
  ModelInfo,
  StructuredOptions,
  TokenHandler,
  TranscriptResult,
  TranscriptSegment,
  TtsOptions,
} from "./types";
import { EngineError } from "./types";
import type { ModelChoice } from "../types";
import { chunkAudioForUpload, type AudioChunk, type AudioDecoder } from "../audio/chunk";
import { pcmFormatFromMime, pcmToWav } from "../audio/wav";
import { blobToBase64, READ_DOCUMENT_MAX_TOKENS, READ_DOCUMENT_PROMPT } from "./vision";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/* Used only when the model list can't be read: Google's alias for its newest
   Flash release. */
export const GEMINI_FALLBACK_MODEL = "gemini-flash-latest";

/* Newest first; each is tried only if the one before it 404s for this key. */
const TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-2.5-flash-preview-tts"];
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_BATCH = 100;

/* Inline requests are capped at 20 MB including base64 (+33%), so audio is
   sent in pieces of at most 12 MB. */
const INLINE_AUDIO_BYTES = 12 * 1024 * 1024;
/* Containers Gemini accepts inline as-is; anything else (m4a, webm, opus…)
   is decoded to WAV first. */
const INLINE_AUDIO_TYPES: Record<string, string> = {
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/mpeg": "audio/mp3",
  "audio/mp3": "audio/mp3",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
  "audio/aac": "audio/aac",
  "audio/aiff": "audio/aiff",
  "audio/x-aiff": "audio/aiff",
};
const TRANSCRIBE_PROMPT =
  "Transcribe this audio verbatim. Output only the transcript text — no timestamps, " +
  "speaker labels, headings or commentary. If there is no speech, output nothing.";

/* Thinking models spend part of maxOutputTokens on reasoning before the
   visible answer. The app's maxTokens budgets the answer (30 for a title),
   so this much is added on top or short answers would come back empty. */
const THINKING_HEADROOM = 2048;

const GEMINI_VOICES = new Set([
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
  "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
  "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]);
/* The podcast picks OpenAI voice names; give each a Gemini counterpart so the
   host and guest still sound different. */
const OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: "Puck",
  ash: "Charon",
  ballad: "Algieba",
  coral: "Aoede",
  echo: "Fenrir",
  fable: "Orus",
  nova: "Kore",
  onyx: "Charon",
  sage: "Leda",
  shimmer: "Zephyr",
  verse: "Achird",
};

export interface GeminiEngineOptions {
  /* Test seam for the audio chunker (no AudioContext under Node). */
  audioDecoder?: AudioDecoder;
}

export class GeminiEngine implements Engine {
  readonly mode = "cloud" as const;
  readonly provider = "gemini" as const;
  private defaults: Promise<{ fast: string; strong: string }> | null = null;
  private readonly audioDecoder?: AudioDecoder;

  constructor(
    private readonly apiKey: string,
    private readonly modelOverride?: string,
    private readonly chosen: ModelChoice = {},
    opts: GeminiEngineOptions = {},
  ) {
    this.audioDecoder = opts.audioDecoder;
  }

  capabilities(): EngineCapabilities {
    return { chat: true, transcription: true, tts: true, embeddings: true, vision: true, visionPdf: true };
  }

  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    const model = await this.resolveModel(opts.tier);
    const res = await this.post(
      `/models/${model}:streamGenerateContent?alt=sse`,
      buildRequest(model, opts),
      opts.signal,
    );

    if (!res.body) throw new EngineError("Gemini returned an empty stream.", "unknown");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let last: GenerateResponse | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        let json: GenerateResponse & { error?: ApiError };
        try {
          json = JSON.parse(data);
        } catch {
          continue; /* malformed SSE chunk; skip it */
        }
        if (json.error) throw errorFrom(json.error.code ?? 500, json.error);
        last = json;
        const text = textOf(json);
        if (text) {
          full += text;
          onToken?.(text);
        }
      }
    }
    if (!full) throw emptyAnswer(last);
    return full;
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    const model = await this.resolveModel(opts.tier);
    const path = `/models/${model}:generateContent`;
    let res: Response;
    try {
      res = await this.post(
        path,
        buildRequest(model, opts, { responseMimeType: "application/json", responseJsonSchema: opts.schema }),
        opts.signal,
      );
    } catch (e) {
      // A model without JSON-Schema support (older or custom ids) rejects the
      // schema field: fall back to plain JSON mode with the schema spelled
      // out in the instructions, the way the local engine does it.
      if (!(e instanceof EngineError && e.kind === "unknown" && /schema/i.test(e.message))) throw e;
      const instruction =
        `Respond ONLY with a single JSON object that satisfies this JSON Schema ` +
        `(no prose, no markdown fences):\n${JSON.stringify(opts.schema)}`;
      res = await this.post(
        path,
        buildRequest(
          model,
          { ...opts, system: opts.system ? `${opts.system}\n\n${instruction}` : instruction },
          { responseMimeType: "application/json" },
        ),
        opts.signal,
      );
    }
    const json = (await res.json()) as GenerateResponse;
    const text = textOf(json);
    if (!text) throw emptyAnswer(json);
    try {
      return JSON.parse(stripJsonFence(text)) as T;
    } catch {
      throw new EngineError("Gemini returned malformed JSON. Try again, or pick another model in Settings.", "unknown");
    }
  }

  async transcribe(audio: Blob, signal?: AbortSignal): Promise<TranscriptResult> {
    const model = await this.resolveModel("strong");
    const inlineType = INLINE_AUDIO_TYPES[audio.type.split(";")[0].trim().toLowerCase()];
    const pieces: AudioChunk[] =
      inlineType && audio.size <= INLINE_AUDIO_BYTES
        ? [{ blob: audio, filename: "audio", offsetSeconds: 0 }]
        : await chunkAudioForUpload(audio, {
            maxBytes: INLINE_AUDIO_BYTES,
            always: true,
            ...(this.audioDecoder ? { decode: this.audioDecoder } : {}),
          });

    const texts: string[] = [];
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const mimeType = INLINE_AUDIO_TYPES[piece.blob.type.split(";")[0].trim().toLowerCase()] ?? "audio/wav";
      const res = await this.post(
        `/models/${model}:generateContent`,
        {
          contents: [
            {
              role: "user",
              parts: [{ inlineData: { mimeType, data: await blobToBase64(piece.blob) } }, { text: TRANSCRIBE_PROMPT }],
            },
          ],
        },
        signal,
      );
      const text = textOf((await res.json()) as GenerateResponse).trim();
      if (!text) continue;
      texts.push(text);
      segments.push({
        start: piece.offsetSeconds,
        end: pieces[i + 1]?.offsetSeconds ?? piece.offsetSeconds,
        text,
      });
    }
    return { text: texts.join(" "), segments };
  }

  async tts(text: string, opts: TtsOptions): Promise<Blob> {
    const voiceName = geminiVoice(opts.voice);
    const tried: string[] = [];
    for (const model of TTS_MODELS) {
      try {
        const res = await this.post(
          `/models/${model}:generateContent`,
          {
            contents: [{ role: "user", parts: [{ text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            },
          },
          opts.signal,
        );
        const json = (await res.json()) as GenerateResponse;
        const audio = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
        if (!audio?.data) throw emptyAnswer(json);
        const bytes = base64ToBytes(audio.data);
        const mime = audio.mimeType ?? "";
        return /wav/i.test(mime)
          ? new Blob([bytes as BlobPart], { type: "audio/wav" })
          : pcmToWav(bytes, pcmFormatFromMime(mime));
      } catch (e) {
        if (e instanceof EngineError && e.kind === "model_missing") {
          tried.push(model);
          continue;
        }
        throw e;
      }
    }
    throw new EngineError(
      `Your Gemini key can't reach a text-to-speech model (tried ${tried.join(", ")}). ` +
        `Check the model list at aistudio.google.com, or use an OpenAI key for voices.`,
      "model_missing",
    );
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = await this.post(
        `/models/${EMBED_MODEL}:batchEmbedContents`,
        {
          requests: batch.map((t) => ({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text: t }] } })),
        },
        signal,
      );
      const json = (await res.json()) as { embeddings?: Array<{ values: number[] }> };
      for (const e of json.embeddings ?? []) out.push(e.values);
    }
    return out;
  }

  /* PDFs and page images both go inline — Gemini reads a scanned PDF as-is,
     no page rendering needed. An empty answer with finishReason STOP means
     the pages really had no text; anything else is reported. */
  async readDocument(parts: DocumentPart[], signal?: AbortSignal): Promise<string> {
    const model = await this.resolveModel("strong");
    const inline = await Promise.all(
      parts.map(async (p) => ({ inlineData: { mimeType: p.mimeType, data: await blobToBase64(p.data) } })),
    );
    const res = await this.post(
      `/models/${model}:generateContent`,
      {
        contents: [{ role: "user", parts: [...inline, { text: READ_DOCUMENT_PROMPT }] }],
        generationConfig: { maxOutputTokens: READ_DOCUMENT_MAX_TOKENS + THINKING_HEADROOM },
      },
      signal,
    );
    const json = (await res.json()) as GenerateResponse;
    const text = textOf(json).trim();
    const finish = json.candidates?.[0]?.finishReason;
    if (!text && (json.promptFeedback?.blockReason || (finish && finish !== "STOP"))) throw emptyAnswer(json);
    return text;
  }

  /* Listing models is free and fails the same way a bad key does. */
  async validate(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE_URL}/models?pageSize=1`, { method: "GET", headers: this.headers() });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await mapError(res);
  }

  private async resolveModel(tier?: "fast" | "strong"): Promise<string> {
    if (this.modelOverride) return this.modelOverride;
    const picked = tier === "strong" ? this.chosen.strong : this.chosen.fast;
    if (picked) return picked;
    const d = await this.defaultModels();
    return tier === "strong" ? d.strong : d.fast;
  }

  /* One GET /models per engine. A failed listing isn't cached — the alias is
     used for this call and the next call lists again. */
  private defaultModels(): Promise<{ fast: string; strong: string }> {
    this.defaults ??= listGeminiModels(this.apiKey)
      .then((models) => pickGeminiDefaults(models.map((m) => m.id)))
      .catch(() => {
        this.defaults = null;
        return { fast: GEMINI_FALLBACK_MODEL, strong: GEMINI_FALLBACK_MODEL };
      });
    return this.defaults;
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", "x-goog-api-key": this.apiKey };
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE_URL}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await mapError(res);
    return res;
  }
}

/* ---- Model list ---------------------------------------------------------- */

/* Text-chat Gemini models this key can call, as GET /models reports them.
   Speech, image, embedding, Live and robotics variants are left out — they
   can't write notes. */
export async function listGeminiModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE_URL}/models?${qs}`, {
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
        signal,
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await mapError(res);
    const json = (await res.json()) as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    };
    for (const m of json.models ?? []) {
      const id = String(m.name ?? "").replace(/^models\//, "");
      if (!id.startsWith("gemini-")) continue;
      if (m.supportedGenerationMethods && !m.supportedGenerationMethods.includes("generateContent")) continue;
      if (/tts|image|embedding|live|native-audio|robotics|computer-use|aqa/i.test(id)) continue;
      out.push({ id, label: m.displayName });
    }
    pageToken = json.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

function versionOf(id: string): number {
  const m = /^gemini-(\d+)(?:\.(\d+))?-/.exec(id);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 0) : -1;
}

/* Default models from what the key can list: the newest stable Flash for the
   heavy work, the newest stable Flash-Lite for the quick calls. */
export function pickGeminiDefaults(ids: string[]): { fast: string; strong: string } {
  const newest = (re: RegExp) => ids.filter((id) => re.test(id)).sort((a, b) => versionOf(b) - versionOf(a))[0];
  const strong =
    newest(/^gemini-\d+(\.\d+)?-flash$/) ??
    (ids.includes(GEMINI_FALLBACK_MODEL) ? GEMINI_FALLBACK_MODEL : undefined) ??
    newest(/^gemini-.*flash(?!-lite)/) ??
    GEMINI_FALLBACK_MODEL;
  const fast = newest(/^gemini-\d+(\.\d+)?-flash-lite$/) ?? strong;
  return { fast, strong };
}

/* ---- Request / response shapes ------------------------------------------- */

interface Part {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

interface ApiError {
  code?: number;
  message?: string;
  status?: string;
  details?: Array<{ reason?: string }>;
}

/* Gemini 3 and newer are tuned for temperature 1.0; Google warns lower
   values can make them loop, so the app's temperature hints are only passed
   to older models (and to custom ids that don't look like Gemini). */
function honoursTemperature(model: string): boolean {
  const m = /^gemini-(\d+)/.exec(model);
  if (m) return Number(m[1]) < 3;
  return !model.startsWith("gemini-");
}

/* Gemini keeps system text in `systemInstruction`, calls the assistant
   "model", and wants turns to alternate — consecutive same-role messages are
   merged. */
function buildRequest(
  model: string,
  opts: CompletionOptions,
  generationConfig: Record<string, unknown> = {},
): Record<string, unknown> {
  const systemParts: string[] = [];
  if (opts.system) systemParts.push(opts.system);
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const m of opts.messages as ChatMessage[]) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push({ text: m.content });
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Begin." }] });

  const config: Record<string, unknown> = { ...generationConfig };
  if (opts.temperature !== undefined && honoursTemperature(model)) config.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) config.maxOutputTokens = opts.maxTokens + THINKING_HEADROOM;

  return {
    ...(systemParts.length ? { systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] } } : {}),
    contents,
    ...(Object.keys(config).length ? { generationConfig: config } : {}),
  };
}

function textOf(json: GenerateResponse | undefined): string {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}

function emptyAnswer(json: GenerateResponse | undefined): EngineError {
  const blocked = json?.promptFeedback?.blockReason;
  if (blocked) return new EngineError(`Gemini blocked this request (${blocked}).`, "unknown");
  const finish = json?.candidates?.[0]?.finishReason;
  if (finish === "MAX_TOKENS") {
    return new EngineError("Gemini ran out of output tokens before answering. Try a non-thinking model in Settings.", "unknown");
  }
  if (finish && finish !== "STOP") return new EngineError(`Gemini stopped without an answer (${finish}).`, "unknown");
  return new EngineError("Gemini returned an empty answer.", "unknown");
}

function stripJsonFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1] : t;
}

function geminiVoice(voice: string): string {
  const named = voice.charAt(0).toUpperCase() + voice.slice(1).toLowerCase();
  if (GEMINI_VOICES.has(named)) return named;
  return OPENAI_VOICE_MAP[voice.toLowerCase()] ?? "Kore";
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ---- Errors -------------------------------------------------------------- */

function toNetworkError(err: unknown): EngineError {
  if (err instanceof Error && err.name === "AbortError") throw err;
  const message = err instanceof Error ? err.message : "Network request failed.";
  return new EngineError(message, "network");
}

async function mapError(res: Response): Promise<EngineError> {
  let error: ApiError = { message: res.statusText || "Gemini request failed." };
  try {
    const body = await res.json();
    // Errors come back as {error} — or, on a stream, as [{error}].
    const e = (Array.isArray(body) ? body[0]?.error : body?.error) as ApiError | undefined;
    if (e) error = { ...e, message: e.message || error.message };
  } catch {
    /* body wasn't JSON */
  }
  return errorFrom(res.status, error);
}

function errorFrom(status: number, error: ApiError): EngineError {
  const message = error.message || "Gemini request failed.";
  const reason = error.details?.find((d) => d.reason)?.reason;
  if (reason === "API_KEY_INVALID" || /API key not valid|API_KEY_INVALID/i.test(message)) {
    return new EngineError("Invalid Gemini API key. Create one at aistudio.google.com/apikey.", "auth");
  }
  if (status === 401 || status === 403) return new EngineError(message, "auth");
  if (status === 404) return new EngineError(`${message} — pick another Gemini model in Settings.`, "model_missing");
  if (status === 429) {
    // "limit: 0" = this model isn't in the key's tier at all (e.g. a Pro
    // model on the free tier). Waiting won't help, so it isn't retried.
    if (/limit: 0\b|billing/i.test(message)) {
      return new EngineError(`${message} — pick another model in Settings, or enable billing for this key.`, "quota");
    }
    return new EngineError(message, "rate_limit");
  }
  // 500/503 "The model is overloaded" — transient, retried with backoff.
  if (status >= 500) return new EngineError(message, "network");
  return new EngineError(message, "unknown");
}
