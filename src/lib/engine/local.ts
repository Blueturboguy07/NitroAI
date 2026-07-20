/* Local implementation of the Engine interface, backed by Ollama
   (https://ollama.com) running on the user's machine. No API key, no
   network egress — this is the fully-offline path.

   Speech-to-text and text-to-speech have no local backend wired up yet
   (whisper.cpp / Kokoro are future work), so those throw a "model_missing"
   EngineError with actionable guidance instead of silently failing. */

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

const DEFAULT_BASE_URL = "http://localhost:11434";
/* qwen2.5:3b — a ~1.9 GB download that runs on modest laptops and is
   reliably good at JSON structured output. Chosen as the default because it's
   the friendliest first-run experience for a non-technical user who picks the
   local engine; power users can point at a larger model in Settings. */
const DEFAULT_MODEL = "qwen2.5:3b";

export class LocalEngine implements Engine {
  readonly mode = "local" as const;

  private readonly baseUrl: string;
  private readonly model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = model ?? DEFAULT_MODEL;
  }

  capabilities(): EngineCapabilities {
    return { chat: true, transcription: false, tts: false, embeddings: true };
  }

  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    const res = await this.post("/api/chat", {
      model: this.model,
      messages: buildMessages(opts),
      stream: true,
      options: buildOptions(opts),
    }, opts.signal);

    if (!res.body) throw new EngineError("Ollama returned an empty stream.", "unknown");
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
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          const delta: string | undefined = json.message?.content;
          if (delta) {
            full += delta;
            onToken?.(delta);
          }
        } catch {
          /* malformed line; skip it */
        }
      }
    }
    return full;
  }

  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    const schemaInstruction =
      `Respond ONLY with a single JSON object that satisfies this JSON Schema ` +
      `(no prose, no markdown fences, no explanation):\n${JSON.stringify(opts.schema)}`;
    const system = opts.system ? `${opts.system}\n\n${schemaInstruction}` : schemaInstruction;

    const messages = [
      { role: "system", content: system },
      ...(opts.messages as ChatMessage[])
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    const res = await this.post("/api/chat", {
      model: this.model,
      messages,
      stream: false,
      format: "json",
      options: buildOptions(opts),
    }, opts.signal);

    const json = await res.json();
    const content: string | undefined = json.message?.content;
    if (!content) {
      throw new EngineError("Ollama returned no content for structured output.", "unknown");
    }
    return JSON.parse(content) as T;
  }

  async transcribe(_audio: Blob, _signal?: AbortSignal): Promise<TranscriptResult> {
    throw new EngineError(
      "Local speech-to-text model not installed. Add an OpenAI key or install a local Whisper server.",
      "model_missing",
    );
  }

  async tts(_text: string, _opts: TtsOptions): Promise<Blob> {
    throw new EngineError("Local text-to-speech (Kokoro) not installed yet.", "model_missing");
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const res = await this.post("/api/embeddings", { model: "nomic-embed-text", prompt: text }, signal);
      const json = await res.json();
      results.push(json.embedding as number[]);
    }
    return results;
  }

  async validate(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`, { method: "GET" });
    } catch {
      throw unreachable(this.baseUrl);
    }
    if (!res.ok) throw unreachable(this.baseUrl);
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw unreachable(this.baseUrl);
    }
    if (!res.ok) throw unreachable(this.baseUrl);
    return res;
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

function buildOptions(opts: CompletionOptions): Record<string, number> {
  const options: Record<string, number> = {};
  if (opts.temperature !== undefined) options.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) options.num_predict = opts.maxTokens;
  return options;
}

function unreachable(baseUrl: string): EngineError {
  return new EngineError(
    `Ollama not reachable at ${baseUrl}. Start Ollama or switch to a cloud key.`,
    "model_missing",
  );
}
