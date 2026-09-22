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
    expect(body.model).toBe("claude-haiku-4-5-20251001");
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

/* ---- publik API through the local proxy ---------------------------------- */
describe("OpenAIEngine as the publik provider", () => {
  const publik = (extra: Parameters<typeof createEngine>[0] extends infer O ? Partial<O> : never = {}) =>
    createEngine({ mode: "cloud", provider: "publik", ...extra });

  it("complete() posts to the local proxy with the publik-fast alias and NO Authorization header", async () => {
    const fetchMock = mockFetch(async () => streamResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`, "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const text = await publik().complete({ messages: [{ role: "user", content: "hi" }] });
    expect(text).toBe("hi");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/publik/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init?.body as string).model).toBe("publik-fast");
  });

  it("tier strong → publik-balanced; credential model map and a pasted pk_ key are honoured", async () => {
    const fetchMock = mockFetch(async () => streamResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await publik().complete({ messages: [{ role: "user", content: "hi" }], tier: "strong" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe("publik-balanced");

    const custom = publik({ models: { fast: "publik-turbo", strong: "publik-mid" }, apiKey: "pk_test_c0m4o1z6s9x3_j5p8t1v4y7a0b3d6e9f2g5h8i1k4l7m0" });
    await custom.complete({ messages: [{ role: "user", content: "hi" }], tier: "strong" });
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).model).toBe("publik-mid");
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer pk_test_c0m4o1z6s9x3_j5p8t1v4y7a0b3d6e9f2g5h8i1k4l7m0",
    );
  });

  it("the BYO OpenAI path is untouched (URL, model, bearer)", async () => {
    const fetchMock = mockFetch(async () => streamResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await createEngine({ mode: "cloud", provider: "openai", apiKey: "sk-test" }).complete({ messages: [{ role: "user", content: "hi" }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init?.body as string).model).toBe("gpt-4o-mini");
  });

  it("402 insufficient_credit → EngineError kind credit with top_up_url and claim_state; never retried by resilient()", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async () =>
        jsonResponse(
          {
            error: {
              type: "insufficient_credit",
              message: "Not enough publik credit for this request.",
              available_micros: 1240,
              required_micros: 41000,
              claim_state: "anonymous",
              top_up_url: "https://publikhq.com/claim/HK7F-2QWD",
              claim_url: "https://publikhq.com/claim/HK7F-2QWD",
              add_credit_url: "https://publikhq.com/dashboard/api/add",
            },
          },
          402,
        ),
      ),
    );
    const { resilient } = await import("./resilient");
    const engine = resilient(publik());
    vi.useFakeTimers();
    try {
      const p = engine.complete({ messages: [{ role: "user", content: "hi" }] });
      const settled = p.then(
        () => "resolved",
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      const e = await settled; // no 3 s backoff sleep was needed
      expect(e).toMatchObject({
        name: "EngineError",
        kind: "credit",
        detail: { topUpUrl: "https://publikhq.com/claim/HK7F-2QWD", claimState: "anonymous" },
      });
    } finally {
      vi.useRealTimers();
    }
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("402 model_requires_claim and 429 daily_cap_reached / week_budget_reached → credit; 429 rate_limit_exceeded stays rate_limit", async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [402, { type: "model_requires_claim", message: "claim first", top_up_url: "https://publikhq.com/claim/X" }, "credit"],
      [429, { type: "daily_cap_reached", message: "cap" }, "credit"],
      [429, { type: "week_budget_reached", message: "week" }, "credit"],
      [429, { type: "rate_limit_exceeded", message: "slow down" }, "rate_limit"],
    ];
    for (const [status, error, kind] of cases) {
      vi.stubGlobal("fetch", mockFetch(async () => new Response(JSON.stringify({ error }), { status, headers: { "retry-after": "120", "content-type": "application/json" } })));
      await expect(publik().structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "s" })).rejects.toMatchObject({ kind });
    }
    vi.stubGlobal("fetch", mockFetch(async () => new Response(JSON.stringify({ error: { type: "daily_cap_reached", message: "cap" } }), { status: 429, headers: { "retry-after": "120" } })));
    await expect(publik().structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "s" })).rejects.toMatchObject({ detail: { retryAfterSeconds: 120 } });
  });

  it("401 key_revoked → auth with detail.disconnected; 400 unknown_model → model_missing; 503 → network (retryable)", async () => {
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ error: { type: "key_revoked", message: "removed", reprovision: false, disconnected: true } }, 401)));
    await expect(publik().validate()).rejects.toMatchObject({ kind: "auth", detail: { disconnected: true } });
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ error: { type: "unknown_model", message: "unknown model" } }, 400)));
    await expect(publik().embed(["x"])).rejects.toMatchObject({ kind: "model_missing" });
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ error: { type: "gateway_unavailable", message: "down" } }, 503)));
    await expect(publik().embed(["x"])).rejects.toMatchObject({ kind: "network" });
  });

  it("x-publik-* headers on a non-stream call feed onUsage; a stream carries only the reservation and is marked streamed", async () => {
    const seen: unknown[] = [];
    const engine = publik({ onUsage: (u) => seen.push(u) });
    vi.stubGlobal(
      "fetch",
      mockFetch(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
          headers: {
            "x-publik-model": "gpt-5.6-luna",
            "x-publik-balance": "123456",
            "x-publik-charge-micros": "150",
            "x-publik-week-used": "1000",
            "x-publik-week-budget": "none",
            "x-publik-week-resets-at": "2026-09-25T17:04:11Z",
            "x-publik-claim-state": "anonymous",
            "x-publik-starter-remaining": "99000",
          },
        }),
      ),
    );
    await engine.structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "s" });
    expect(seen[0]).toEqual({
      streamed: false,
      model: "gpt-5.6-luna",
      balanceMicros: 123456,
      chargeMicros: 150,
      reservedMicros: undefined,
      weekUsedMicros: 1000,
      weekBudgetMicros: null,
      weekResetsAt: "2026-09-25T17:04:11Z",
      claimState: "anonymous",
      starterRemainingMicros: 99000,
    });

    vi.stubGlobal("fetch", mockFetch(async () => new Response(streamResponse(["data: [DONE]\n\n"]).body, { status: 200, headers: { "x-publik-reserved-micros": "4100" } })));
    await engine.complete({ messages: [{ role: "user", content: "x" }] });
    expect(seen[1]).toMatchObject({ streamed: true, reservedMicros: 4100, balanceMicros: undefined, chargeMicros: undefined });

    // The OpenAI path never fires it.
    const openai = createEngine({ mode: "cloud", provider: "openai", apiKey: "sk-x", onUsage: (u) => seen.push(u) });
    vi.stubGlobal("fetch", mockFetch(async () => jsonResponse({ choices: [{ message: { content: "{}" } }] })));
    await openai.structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "s" });
    expect(seen).toHaveLength(2);
  });

  it("capabilities default to every line; a chat-only credential rejects audio/tts/embeddings before any fetch", async () => {
    expect(publik().capabilities()).toEqual({ chat: true, transcription: true, tts: true, embeddings: true });
    const fetchMock = mockFetch(async () => {
      throw new Error("should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const chatOnly = publik({ capabilities: { chat: true, transcription: false, tts: false, embeddings: false } });
    await expect(chatOnly.transcribe(new Blob(["a"]))).rejects.toMatchObject({ kind: "unsupported" });
    await expect(chatOnly.tts("hi", { voice: "alloy" })).rejects.toMatchObject({ kind: "unsupported" });
    await expect(chatOnly.embed(["hi"])).rejects.toMatchObject({ kind: "unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(chatOnly.transcribe(new Blob(["a"]))).rejects.toThrow(/publik API/);
  });

  it("transcribe() sends small audio whole via the proxy and chunks large audio into ≤4 MB WAV pieces with shifted segments", async () => {
    const calls: Array<{ url: string; name: string; size: number; type: string }> = [];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch(async (url, init) => {
        const form = init?.body as FormData;
        const f = form.get("file") as File;
        calls.push({ url: String(url), name: f.name, size: f.size, type: String(form.get("model")) });
        n++;
        return jsonResponse({ text: `part${n}`, language: "en", segments: [{ start: 0, end: 1, text: `part${n}` }] });
      }),
    );
    const decode = async () => ({ sampleRate: 16_000, channels: [new Float32Array(16_000 * 300)] }); // 5 min mono 16 k
    const engine = new OpenAIEngine("", undefined, { provider: "publik", baseUrl: "/api/publik/v1", audioDecoder: decode });

    const small = await engine.transcribe(new Blob([new Uint8Array(1000)]));
    expect(small.text).toBe("part1");
    expect(calls[0]).toMatchObject({ url: "/api/publik/v1/audio/transcriptions", name: "audio.webm", size: 1000, type: "whisper-1" });

    calls.length = 0;
    const big = await engine.transcribe(new Blob([new Uint8Array(5 * 1024 * 1024)]));
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.size).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(c.name).toMatch(/^chunk-\d+\.wav$/);
    }
    expect(big.text).toBe(calls.map((_, i) => `part${i + 2}`).join(" "));
    expect(big.segments[0].start).toBe(0);
    expect(big.segments[1].start).toBeGreaterThan(100); // shifted by the first chunk's length in seconds
    expect(big.language).toBe("en");
  });

  it("tts() on publik tries tts-1 then tts-1-hd, never the OpenAI-only model", async () => {
    const models: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch(async (_url, init) => {
        models.push(JSON.parse(init?.body as string).model);
        return jsonResponse({ error: { type: "unknown_model", message: "nope" } }, 400);
      }),
    );
    await expect(publik().tts("hi", { voice: "alloy" })).rejects.toMatchObject({ kind: "model_missing" });
    expect(models).toEqual(["tts-1", "tts-1-hd"]);
  });

  it("createEngine needs no key for publik but still requires one for openai/anthropic", () => {
    expect(createEngine({ mode: "cloud", provider: "publik" })).toBeInstanceOf(OpenAIEngine);
    expect(createEngine({ mode: "cloud", provider: "publik" }).provider).toBe("publik");
    expect(() => createEngine({ mode: "cloud", provider: "openai" })).toThrow(EngineError);
  });
});
