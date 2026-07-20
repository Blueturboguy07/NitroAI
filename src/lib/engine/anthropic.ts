/* Anthropic implementation of the Engine interface. Cloud mode, provider
   "anthropic". Talks to the Messages API directly via `fetch`.

   Anthropic has no first-party transcription/TTS/embeddings endpoints, so
   those three methods throw a friendly "unsupported" EngineError — callers
   should check `capabilities()` (or use src/lib/engine/router.ts) before
   calling them. */

import type {
  ChatMessage,
  CompletionOptions,
  Engine,
  EngineCapabilities,
  StructuredOptions,
  TokenHandler,
  TranscriptResult,
  TtsOptions,
} from "./types";
import { EngineError } from "./types";

const BASE_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

const UNSUPPORTED_MESSAGE =
  "Anthropic does not support this operation; use an OpenAI key or local models.";

export class AnthropicEngine implements Engine {
  readonly mode = "cloud" as const;
  readonly provider = "anthropic" as const;

  constructor(
    private readonly apiKey: string,
    private readonly modelOverride?: string,
  ) {}

  capabilities(): EngineCapabilities {
    return { chat: true, transcription: false, tts: false, embeddings: false };
  }

  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    const { system, messages } = buildSystemAndMessages(opts);
    const res = await this.post({
      model: this.resolveModel(opts.tier),
      max_tokens: opts.maxTokens ?? 4096,
      messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }, opts.signal);

    if (!res.body) throw new EngineError("Anthropic returned an empty stream.", "unknown");
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
        if (!data) continue;
        try {
          const json = JSON.parse(data);
          if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
            const text: string = json.delta.text ?? "";
            if (text) {
              full += text;
              onToken?.(text);
            }
          }
        } catch {
          /* malformed SSE chunk; skip it */
        }
      }
    }
    return full;
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    const { system, messages } = buildSystemAndMessages(opts);
    const toolName = opts.schemaName || "structured_output";
    const res = await this.post({
      model: this.resolveModel(opts.tier),
      max_tokens: opts.maxTokens ?? 4096,
      messages,
      ...(system ? { system } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      tools: [
        {
          name: toolName,
          description: `Produce output matching the ${toolName} schema.`,
          input_schema: opts.schema,
        },
      ],
      tool_choice: { type: "tool", name: toolName },
    }, opts.signal);

    const json = await res.json();
    const blocks: Array<{ type: string; name?: string; input?: unknown }> = json.content ?? [];
    const block = blocks.find((b) => b.type === "tool_use" && b.name === toolName);
    if (!block) {
      throw new EngineError("Anthropic did not return a structured tool_use block.", "unknown");
    }
    return block.input as T;
  }

  async transcribe(_audio: Blob, _signal?: AbortSignal): Promise<TranscriptResult> {
    throw new EngineError(UNSUPPORTED_MESSAGE, "unsupported");
  }

  async tts(_text: string, _opts: TtsOptions): Promise<Blob> {
    throw new EngineError(UNSUPPORTED_MESSAGE, "unsupported");
  }

  async embed(_texts: string[], _signal?: AbortSignal): Promise<number[][]> {
    throw new EngineError(UNSUPPORTED_MESSAGE, "unsupported");
  }

  async validate(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.resolveModel("fast"),
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (res.status === 401) throw new EngineError("Invalid Anthropic API key.", "auth");
    if (!res.ok) throw await mapError(res);
  }

  private resolveModel(tier?: "fast" | "strong"): string {
    if (this.modelOverride) return this.modelOverride;
    return tier === "strong" ? "claude-3-5-sonnet-latest" : "claude-3-5-haiku-latest";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": API_VERSION,
      /* Required for the key to be usable directly from a browser/renderer
         context (Tauri webview) instead of only from a server. */
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/messages`, {
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

/* Anthropic keeps system instructions in a top-level `system` field (never in
   `messages`), so any ChatMessage with role "system" is folded into it. The
   system field is wrapped in the content-block array form so it can carry
   cache_control — worthwhile once system + few-shot context gets long. */
function buildSystemAndMessages(
  opts: CompletionOptions,
): { system: Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }> | null; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const systemParts: string[] = [];
  if (opts.system) systemParts.push(opts.system);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of opts.messages as ChatMessage[]) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const system = systemParts.length
    ? [{ type: "text" as const, text: systemParts.join("\n\n"), cache_control: { type: "ephemeral" as const } }]
    : null;
  return { system, messages };
}

function toNetworkError(err: unknown): EngineError {
  if (err instanceof Error && err.name === "AbortError") throw err;
  const message = err instanceof Error ? err.message : "Network request failed.";
  return new EngineError(message, "network");
}

async function mapError(res: Response): Promise<EngineError> {
  let message = res.statusText || "Anthropic request failed.";
  let type: string | undefined;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
    type = body?.error?.type;
  } catch {
    /* body wasn't JSON */
  }
  if (res.status === 401) return new EngineError(message, "auth");
  if (res.status === 429) return new EngineError(message, "rate_limit");
  if (type === "quota_exceeded" || type === "billing_error") return new EngineError(message, "quota");
  return new EngineError(message, "unknown");
}
