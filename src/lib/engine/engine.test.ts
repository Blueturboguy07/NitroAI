import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEngine } from "./openai";
import { AnthropicEngine } from "./anthropic";
import { LocalEngine } from "./local";
import { createEngine } from "./index";
import { EngineError } from "./types";

/* Builds a fake streaming Response whose body yields the given raw SSE/NDJSON
   chunks one at a time, mirroring how a real fetch ReadableStream arrives. */
function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* Typed wrapper around vi.fn() so `.mock.calls[n]` comes back as
   [url, init?] instead of an inferred empty tuple. */
function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(impl);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIEngine", () => {
  it("complete() streams tokens and returns concatenated text", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const fetchMock = mockFetch(async () => streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenAIEngine("sk-test");
    const tokens: string[] = [];
    const text = await engine.complete(
      { messages: [{ role: "user", content: "hi" }] },
      (t) => tokens.push(t),
    );

    expect(text).toBe("Hello world");
    expect(tokens).toEqual(["Hello", " world"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(true);
  });

  it("complete() uses the strong-tier model and a constructor override", async () => {
    const fetchMock = mockFetch(async () => streamResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const strong = new OpenAIEngine("sk-test");
    await strong.complete({ messages: [{ role: "user", content: "hi" }], tier: "strong" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe("gpt-4o");

    const overridden = new OpenAIEngine("sk-test", "gpt-4o-2024-08-06");
    await overridden.complete({ messages: [{ role: "user", content: "hi" }], tier: "fast" });
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).model).toBe("gpt-4o-2024-08-06");
  });

  it("structured() parses the JSON content returned by the model", async () => {
    const payload = { name: "Ada", age: 30 };
    const fetchMock = mockFetch(async () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenAIEngine("sk-test");
    const result = await engine.structured<typeof payload>({
      messages: [{ role: "user", content: "extract the person" }],
      schema: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } } },
      schemaName: "person",
    });

    expect(result).toEqual(payload);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "person", schema: expect.any(Object), strict: true },
    });
  });

  it("maps a 401 response to an auth EngineError", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () => jsonResponse({ error: { message: "Incorrect API key" } }, 401)),
    );
    const engine = new OpenAIEngine("sk-bad");
    await expect(engine.validate()).rejects.toMatchObject({ name: "EngineError", kind: "auth" });
  });

  it("maps insufficient_quota to a quota EngineError even on HTTP 429", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () =>
        jsonResponse({ error: { message: "You exceeded your quota", code: "insufficient_quota" } }, 429),
      ),
    );
    const engine = new OpenAIEngine("sk-test");
    await expect(
      engine.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "EngineError", kind: "quota" });
  });

  it("wraps a network failure as a network EngineError", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const engine = new OpenAIEngine("sk-test");
    await expect(
      engine.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "EngineError", kind: "network" });
  });
});

describe("AnthropicEngine", () => {
  it("complete() parses the Anthropic content_block_delta SSE stream", async () => {
    const chunks = [
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hi" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: " there" },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const fetchMock = mockFetch(async () => streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new AnthropicEngine("sk-ant-test");
    const text = await engine.complete({
      system: "Be terse.",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(text).toBe("Hi there");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("claude-3-5-haiku-latest");
    expect(body.system[0].text).toBe("Be terse.");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("structured() sends a forced tool_choice and parses tool_use input", async () => {
    const payload = { title: "Photosynthesis", topic: "biology" };
    const fetchMock = mockFetch(async () =>
      jsonResponse({ content: [{ type: "tool_use", name: "note", input: payload }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const engine = new AnthropicEngine("sk-ant-test");
    const result = await engine.structured<typeof payload>({
      messages: [{ role: "user", content: "extract" }],
      schema: { type: "object" },
      schemaName: "note",
    });

    expect(result).toEqual(payload);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.tool_choice).toEqual({ type: "tool", name: "note" });
    expect(body.tools[0].name).toBe("note");
  });

  it("transcribe() throws an EngineError with kind unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () => {
        throw new Error("should not be called");
      }),
    );
    const engine = new AnthropicEngine("sk-ant-test");
    await expect(engine.transcribe(new Blob(["audio"]))).rejects.toMatchObject({
      name: "EngineError",
      kind: "unsupported",
    });
  });

  it("tts() and embed() also throw kind unsupported", async () => {
    const engine = new AnthropicEngine("sk-ant-test");
    await expect(engine.tts("hello", { voice: "alloy" })).rejects.toBeInstanceOf(EngineError);
    await expect(engine.embed(["hello"])).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("capabilities() reports no transcription/tts/embeddings", () => {
    const engine = new AnthropicEngine("sk-ant-test");
    expect(engine.capabilities()).toEqual({
      chat: true,
      transcription: false,
      tts: false,
      embeddings: false,
    });
  });

  it("validate() maps a 401 to an auth EngineError", async () => {
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ error: { message: "bad key" } }, 401)));
    const engine = new AnthropicEngine("sk-ant-bad");
    await expect(engine.validate()).rejects.toMatchObject({ name: "EngineError", kind: "auth" });
  });
});

describe("LocalEngine", () => {
  it("complete() parses newline-delimited JSON chunks from Ollama", async () => {
    const chunks = [
      `${JSON.stringify({ message: { content: "Hel" }, done: false })}\n`,
      `${JSON.stringify({ message: { content: "lo" }, done: false })}\n`,
      `${JSON.stringify({ message: { content: "" }, done: true })}\n`,
    ];
    const fetchMock = mockFetch(async () => streamResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const engine = new LocalEngine();
    const tokens: string[] = [];
    const text = await engine.complete(
      { messages: [{ role: "user", content: "hi" }] },
      (t) => tokens.push(t),
    );

    expect(text).toBe("Hello");
    expect(tokens).toEqual(["Hel", "lo"]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
  });

  it("transcribe() and tts() throw model_missing", async () => {
    const engine = new LocalEngine();
    await expect(engine.transcribe(new Blob(["audio"]))).rejects.toMatchObject({
      name: "EngineError",
      kind: "model_missing",
    });
    await expect(engine.tts("hi", { voice: "default" })).rejects.toMatchObject({
      kind: "model_missing",
    });
  });

  it("validate() throws model_missing when Ollama is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const engine = new LocalEngine("http://localhost:11434");
    await expect(engine.validate()).rejects.toMatchObject({
      name: "EngineError",
      kind: "model_missing",
    });
  });
});

describe("createEngine", () => {
  it("returns the right class per mode/provider", () => {
    expect(createEngine({ mode: "cloud", provider: "openai", apiKey: "sk-x" })).toBeInstanceOf(
      OpenAIEngine,
    );
    expect(
      createEngine({ mode: "cloud", provider: "anthropic", apiKey: "sk-ant-x" }),
    ).toBeInstanceOf(AnthropicEngine);
    expect(createEngine({ mode: "local" })).toBeInstanceOf(LocalEngine);
  });

  it("throws when cloud mode is missing an API key or provider", () => {
    expect(() => createEngine({ mode: "cloud" })).toThrow(EngineError);
    expect(() => createEngine({ mode: "cloud", apiKey: "sk-x" })).toThrow(EngineError);
  });
});
