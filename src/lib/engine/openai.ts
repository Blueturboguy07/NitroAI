/* OpenAI-dialect implementation of the Engine interface. Cloud mode.
   Uses the REST API directly via `fetch` — no SDK dependency.

   Two providers share this class:
     • "openai" — the user's own sk- key against https://api.openai.com/v1
       (unchanged behaviour).
     • "publik" — publik API. The renderer never talks to publikhq.com
       itself: `baseUrl` points at the local server's proxy (/api/publik/v1),
       which attaches the machine's pk_ key and streams the answer back. Model
       names are the publik aliases from the credential; 402/429 credit
       answers become `EngineError kind:"credit"`; the x-publik-* headers feed
       the balance line through `onUsage`. */

import type {
  ChatMessage,
  CompletionOptions,
  Engine,
  EngineCapabilities,
  StructuredOptions,
  TokenHandler,
  TranscriptResult,
  TranscriptSegment,
  TtsOptions,
} from "./types";
import { EngineError } from "./types";
import { unsupportedMessage, type Task } from "./router";
import { chunkAudioForUpload, type AudioChunk, type AudioDecoder } from "../audio/chunk";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const ALL_CAPS: EngineCapabilities = { chat: true, transcription: true, tts: true, embeddings: true };

/* What the gateway stamps on every metered call (contract §1). Streams settle
   after the headers, so on a stream only `reservedMicros` is meaningful and the
   balance is reconciled from GET /wallet by the caller. */
export interface UsageHeaders {
  chargeMicros?: number;
  balanceMicros?: number;
  reservedMicros?: number;
  weekUsedMicros?: number;
  weekBudgetMicros?: number | null;
  weekResetsAt?: string;
  claimState?: string;
  starterRemainingMicros?: number;
  model?: string;
  streamed: boolean;
}

export interface OpenAIEngineOptions {
  baseUrl?: string;
  provider?: "openai" | "publik";
  models?: { fast: string; strong: string };
  capabilities?: EngineCapabilities;
  onUsage?: (u: UsageHeaders) => void;
  /* Test seam for the audio chunker (no AudioContext under Node). */
  audioDecoder?: AudioDecoder;
}

export class OpenAIEngine implements Engine {
  readonly mode = "cloud" as const;
  readonly provider: "openai" | "publik";
  private readonly baseUrl: string;
  private readonly models: { fast: string; strong: string };
  private readonly caps: EngineCapabilities;
  private readonly onUsage?: (u: UsageHeaders) => void;
  private readonly audioDecoder?: AudioDecoder;

  constructor(
    private readonly apiKey: string,
    private readonly modelOverride?: string,
    opts: OpenAIEngineOptions = {},
  ) {
    this.provider = opts.provider ?? "openai";
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.models = opts.models ?? { fast: "gpt-4o-mini", strong: "gpt-4o" };
    this.caps = opts.capabilities ?? { ...ALL_CAPS };
    this.onUsage = opts.onUsage;
    this.audioDecoder = opts.audioDecoder;
  }

  capabilities(): EngineCapabilities {
    return { ...this.caps };
  }

  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    const res = await this.post("/chat/completions", {
      model: this.resolveModel(opts.tier),
      messages: buildMessages(opts),
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    }, opts.signal, true);

    if (!res.body) throw new EngineError(`${this.label()} returned an empty stream.`, "unknown");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

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
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onToken?.(delta);
          }
        } catch {
          /* malformed SSE chunk; skip it */
        }
      }
    }
    return full;
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    const res = await this.post("/chat/completions", {
      model: this.resolveModel(opts.tier),
      messages: buildMessages(opts),
      stream: false,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.schemaName, schema: opts.schema, strict: true },
      },
    }, opts.signal);

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new EngineError(`${this.label()} returned no structured content.`, "unknown");
    }
    return JSON.parse(content) as T;
  }

  async transcribe(audio: Blob, signal?: AbortSignal): Promise<TranscriptResult> {
    this.assertCap("transcription");
    /* publik API sits behind a 4 MB request cap: chunk client-side. The BYO
       path keeps sending the file whole (OpenAI's own limit is 25 MB and the
       pipeline already guards at 24 MB). */
    const chunks: AudioChunk[] =
      this.provider === "publik"
        ? await chunkAudioForUpload(audio, this.audioDecoder ? { decode: this.audioDecoder } : {})
        : [{ blob: audio, filename: "audio.webm", offsetSeconds: 0 }];

    const texts: string[] = [];
    const segments: TranscriptSegment[] = [];
    let language: string | undefined;
    for (const chunk of chunks) {
      const form = new FormData();
      form.append("file", chunk.blob, chunk.filename);
      form.append("model", "whisper-1");
      form.append("response_format", "verbose_json");

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: this.authHeaders(),
          body: form,
          signal,
        });
      } catch (err) {
        throw toNetworkError(err);
      }
      if (!res.ok) throw await this.mapError(res);
      this.readUsage(res, false);

      const json = await res.json();
      if (typeof json.text === "string" && json.text.trim()) texts.push(json.text.trim());
      if (Array.isArray(json.segments)) {
        for (const s of json.segments as Array<{ start: number; end: number; text: string }>) {
          segments.push({ start: s.start + chunk.offsetSeconds, end: s.end + chunk.offsetSeconds, text: s.text });
        }
      }
      language ??= json.language;
    }
    return { text: texts.join(" "), segments, language };
  }

  async tts(text: string, opts: TtsOptions): Promise<Blob> {
    this.assertCap("tts");
    /* Try TTS models newest→oldest, falling through ONLY when a model is
       inaccessible to this key/project (needs verification or isn't in the
       project's model limits). Any other failure — auth, quota, network,
       bad input — rethrows immediately since retrying a different model
       won't help. publik's price sheet carries tts-1 / tts-1-hd. */
    const models = this.provider === "publik" ? ["tts-1", "tts-1-hd"] : ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
    const tried: string[] = [];
    for (const model of models) {
      try {
        const res = await this.post(
          "/audio/speech",
          {
            model,
            voice: opts.voice,
            input: text,
            ...(opts.format ? { response_format: opts.format } : {}),
          },
          opts.signal,
        );
        return res.blob();
      } catch (e) {
        if (e instanceof EngineError && e.kind === "model_missing") {
          tried.push(model);
          continue;
        }
        throw e;
      }
    }
    /* Every candidate was inaccessible — name them all so the user knows
       exactly which models to enable, not just the last one attempted. */
    if (this.provider === "publik") {
      throw new EngineError(
        `publik API couldn't serve a text-to-speech model (tried ${tried.join(", ")}). Try again later, or add your own OpenAI key in Settings for voices.`,
        "model_missing",
      );
    }
    throw new EngineError(
      `Your OpenAI project can't access any text-to-speech model (tried ${tried.join(
        ", ",
      )}). Enable one at platform.openai.com → Settings → Project → Limits, ` +
        `and if your account is new you may also need to verify your organization there.`,
      "model_missing",
    );
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.assertCap("embeddings");
    const res = await this.post("/embeddings", {
      model: "text-embedding-3-small",
      input: texts,
    }, signal);
    const json = await res.json();
    return (json.data ?? []).map((d: { embedding: number[] }) => d.embedding);
  }

  async validate(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models`, { method: "GET", headers: this.headers() });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (res.status === 401) {
      if (this.provider === "publik") throw await this.mapError(res);
      throw new EngineError("Invalid OpenAI API key.", "auth");
    }
    if (!res.ok) throw await this.mapError(res);
    this.readUsage(res, false);
  }

  private label(): string {
    return this.provider === "publik" ? "publik API" : "OpenAI";
  }

  private assertCap(task: Task): void {
    if (!this.caps[task === "transcription" ? "transcription" : task]) {
      throw new EngineError(unsupportedMessage(task, this.provider), "unsupported");
    }
  }

  private resolveModel(tier?: "fast" | "strong"): string {
    if (this.modelOverride) return this.modelOverride;
    return tier === "strong" ? this.models.strong : this.models.fast;
  }

  /* On the publik path through the local proxy there is no key in the
     renderer — the proxy attaches it. A user-pasted pk_ key (BYO field) rides
     along as Bearer and the proxy honours it. */
  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", ...this.authHeaders() };
  }

  /* Balance line feed: x-publik-* headers (contract §1). Absent on the OpenAI
     path, so `onUsage` only ever fires with real numbers. */
  private readUsage(res: Response, streamed: boolean): void {
    if (!this.onUsage) return;
    const h = (name: string) => res.headers.get(name);
    const num = (name: string) => {
      const v = h(name);
      if (v === null || v === "" || v === "none") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const model = h("x-publik-model") ?? undefined;
    const balance = num("x-publik-balance") ?? num("x-publik-balance-micros");
    if (model === undefined && balance === undefined && num("x-publik-reserved-micros") === undefined) return;
    this.onUsage({
      streamed,
      model,
      balanceMicros: balance,
      chargeMicros: num("x-publik-charge-micros"),
      reservedMicros: num("x-publik-reserved-micros"),
      weekUsedMicros: num("x-publik-week-used"),
      weekBudgetMicros: h("x-publik-week-budget") === "none" ? null : num("x-publik-week-budget"),
      weekResetsAt: h("x-publik-week-resets-at") ?? undefined,
      claimState: h("x-publik-claim-state") ?? undefined,
      starterRemainingMicros: num("x-publik-starter-remaining"),
    });
  }

  /* Shared POST helper: sends JSON, handles network failure + non-2xx mapping. */
  private async post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    streamed = false,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await this.mapError(res);
    this.readUsage(res, streamed);
    return res;
  }

  private async mapError(res: Response): Promise<EngineError> {
    return mapError(res, this.provider);
  }
}

function buildMessages(opts: CompletionOptions): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  if (opts.system) out.push({ role: "system", content: opts.system });
  for (const m of opts.messages as ChatMessage[]) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/* User-initiated cancellation should surface as a native AbortError, not get
   reinterpreted as a network failure. */
function toNetworkError(err: unknown): EngineError {
  if (err instanceof Error && err.name === "AbortError") throw err;
  const message = err instanceof Error ? err.message : "Network request failed.";
  return new EngineError(message, "network");
}

interface ApiErrorBody {
  error?: {
    message?: string;
    code?: string;
    type?: string;
    top_up_url?: string;
    claim_state?: string;
    reprovision?: boolean;
    disconnected?: boolean;
  };
}

async function mapError(res: Response, provider: "openai" | "publik"): Promise<EngineError> {
  let message = res.statusText || `${provider === "publik" ? "publik API" : "OpenAI"} request failed.`;
  let code: string | undefined;
  let type: string | undefined;
  let body: ApiErrorBody | undefined;
  try {
    body = (await res.json()) as ApiErrorBody;
    if (body?.error?.message) message = body.error.message;
    code = body?.error?.code;
    type = body?.error?.type;
  } catch {
    /* body wasn't JSON */
  }

  if (provider === "publik") {
    /* Contract §1. 402 = out of credit (or publik-smart asked for while
       anonymous): the app renders the message plus exactly one link,
       top_up_url. Never retried (resilient() skips "credit"). */
    if (res.status === 402) {
      return new EngineError(message, "credit", {
        topUpUrl: body?.error?.top_up_url ?? null,
        claimState: body?.error?.claim_state,
      });
    }
    if (res.status === 429 && (type === "daily_cap_reached" || type === "week_budget_reached")) {
      return new EngineError(message, "credit", {
        retryAfterSeconds: Number(res.headers.get("retry-after")) || 3600,
        topUpUrl: body?.error?.top_up_url ?? null,
        claimState: body?.error?.claim_state,
      });
    }
    if (res.status === 401) {
      // key_revoked with reprovision:false — the proxy has already marked
      // the install disconnected; the UI shows "publik API is disconnected".
      return new EngineError(message, "auth", {
        disconnected: type === "key_revoked" || body?.error?.disconnected === true,
      });
    }
    if (res.status === 400 && type === "unknown_model") return new EngineError(message, "model_missing");
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return new EngineError(
        "publik API is unreachable right now. Nothing is being charged. Try again in a minute, or use your own key.",
        "network",
      );
    }
  }

  /* OpenAI returns HTTP 429 for both rate limits and quota exhaustion — check
     the error code first so quota errors aren't misreported as rate_limit. */
  if (code === "insufficient_quota" || type === "insufficient_quota") {
    return new EngineError(message, "quota");
  }
  /* Project-scoped keys can be missing access to specific models (e.g. TTS).
     Surface that as a clear, actionable message rather than a raw API error. */
  if (
    code === "model_not_found" ||
    /does not have access to model|model_not_found|must be verified to use the model/i.test(
      message,
    )
  ) {
    return new EngineError(
      provider === "publik"
        ? message
        : `${message} — enable this model for your OpenAI project at platform.openai.com → Settings → Project → Limits.`,
      "model_missing",
    );
  }
  if (res.status === 401) return new EngineError(message, "auth");
  if (res.status === 429) return new EngineError(message, "rate_limit");
  if (res.status === 403) return new EngineError(message, "model_missing");
  return new EngineError(message, "unknown");
}
