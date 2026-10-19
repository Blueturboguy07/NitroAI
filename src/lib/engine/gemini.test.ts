import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiEngine, pickGeminiDefaults } from "./gemini";
import { createEngine } from "./index";
import { parseWav } from "../audio/wav";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const KEY = "AIzaSyTestKey0123456789abcdefghijklmno";

function sse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\r\n\r\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function answer(text: string) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
}

const MODEL_LIST = {
  models: [
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.6-flash", displayName: "Gemini 3.6 Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemma-3-27b-it", supportedGenerationMethods: ["generateContent"] },
  ],
};

type Call = [string, RequestInit | undefined];
function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn as unknown as { mock: { calls: Call[] } } & typeof fn;
}
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeminiEngine", () => {
  it("complete() streams SSE text with the key header, systemInstruction and model roles", async () => {
    const fetchMock = mockFetch(async (url) =>
      url.includes("/models?") ? json(MODEL_LIST) : sse([answer("Hello"), answer(" world")]),
    );
    const tokens: string[] = [];
    const text = await new GeminiEngine(KEY).complete(
      {
        system: "Be brief.",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "again" },
          { role: "user", content: "and again" },
        ],
        tier: "strong",
      },
      (t) => tokens.push(t),
    );
    expect(text).toBe("Hello world");
    expect(tokens).toEqual(["Hello", " world"]);

    const [url, init] = fetchMock.mock.calls[1];
    // Newest stable Flash from the list is the default "strong" model.
    expect(url).toBe(`${BASE}/models/gemini-3.8-flash:streamGenerateContent?alt=sse`);
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    const body = bodyOf(init);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be brief." }] });
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[2].parts).toEqual([{ text: "again" }, { text: "and again" }]);
  });

  it("uses the Flash-Lite default for the fast tier and lists models only once", async () => {
    const fetchMock = mockFetch(async (url) => (url.includes("/models?") ? json(MODEL_LIST) : sse([answer("ok")])));
    const engine = new GeminiEngine(KEY);
    await engine.complete({ messages: [{ role: "user", content: "hi" }], tier: "fast" });
    await engine.complete({ messages: [{ role: "user", content: "hi" }] });
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls.filter((u) => u.includes("/models?"))).toHaveLength(1);
    expect(urls[1]).toContain("/models/gemini-3.5-flash-lite:streamGenerateContent");
  });

  it("uses the models chosen in Settings without listing", async () => {
    const fetchMock = mockFetch(async () => sse([answer("ok")]));
    const engine = new GeminiEngine(KEY, undefined, { fast: "gemini-2.5-flash", strong: "gemini-3.1-pro-preview" });
    await engine.complete({ messages: [{ role: "user", content: "hi" }], tier: "strong", temperature: 0.2 });
    await engine.complete({ messages: [{ role: "user", content: "hi" }], tier: "fast", temperature: 0.2, maxTokens: 30 });
    expect(fetchMock.mock.calls[0][0]).toContain("/models/gemini-3.1-pro-preview:");
    expect(fetchMock.mock.calls[1][0]).toContain("/models/gemini-2.5-flash:");
    // Gemini 3+ keeps its default temperature; 2.5 honours the hint.
    expect(bodyOf(fetchMock.mock.calls[0][1]).generationConfig).toBeUndefined();
    // maxTokens gets thinking headroom so a 30-token title isn't eaten by reasoning.
    expect(bodyOf(fetchMock.mock.calls[1][1]).generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 2078 });
  });

  it("falls back to the -latest alias when the model list can't be read", async () => {
    const fetchMock = mockFetch(async (url) => (url.includes("/models?") ? json({}, 500) : sse([answer("ok")])));
    await new GeminiEngine(KEY).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(fetchMock.mock.calls[1][0]).toContain("/models/gemini-flash-latest:");
  });

  it("structured() sends responseJsonSchema and parses the JSON answer", async () => {
    const fetchMock = mockFetch(async () => json(answer('{"topics":["a","b"]}')));
    const schema = { type: "object", additionalProperties: false, required: ["topics"], properties: { topics: { type: "array", items: { type: "string" } } } };
    const out = await new GeminiEngine(KEY, "gemini-3.8-flash").structured<{ topics: string[] }>({
      messages: [{ role: "user", content: "x" }],
      schema,
      schemaName: "topics",
    });
    expect(out).toEqual({ topics: ["a", "b"] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/models/gemini-3.8-flash:generateContent`);
    expect(bodyOf(init).generationConfig).toEqual({ responseMimeType: "application/json", responseJsonSchema: schema });
  });

  it("structured() retries in plain JSON mode when the model rejects the schema field", async () => {
    let n = 0;
    const fetchMock = mockFetch(async () =>
      n++ === 0
        ? json({ error: { code: 400, status: "INVALID_ARGUMENT", message: 'Unknown name "responseJsonSchema"' } }, 400)
        : json(answer('```json\n{"ok":true}\n```')),
    );
    const out = await new GeminiEngine(KEY, "custom-model").structured<{ ok: boolean }>({
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object" },
      schemaName: "s",
    });
    expect(out).toEqual({ ok: true });
    const retry = bodyOf(fetchMock.mock.calls[1][1]);
    expect(retry.generationConfig).toEqual({ responseMimeType: "application/json" });
    expect(retry.systemInstruction.parts[0].text).toMatch(/JSON Schema/);
  });

  it("maps Gemini errors to engine error kinds", async () => {
    const engine = new GeminiEngine(KEY, "gemini-3.8-flash");
    const run = () => engine.structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "s" });

    mockFetch(async () =>
      json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }, 400),
    );
    await expect(run()).rejects.toMatchObject({ kind: "auth" });

    mockFetch(async () => json({ error: { code: 404, message: "models/x is not found" } }, 404));
    await expect(run()).rejects.toMatchObject({ kind: "model_missing" });

    mockFetch(async () => json({ error: { code: 429, message: "Quota exceeded for metric: free_tier_requests, limit: 0" } }, 429));
    await expect(run()).rejects.toMatchObject({ kind: "quota" });

    mockFetch(async () => json({ error: { code: 429, message: "Resource has been exhausted" } }, 429));
    await expect(run()).rejects.toMatchObject({ kind: "rate_limit" });

    mockFetch(async () => json({ error: { code: 503, message: "The model is overloaded." } }, 503));
    await expect(run()).rejects.toMatchObject({ kind: "network" });
  });

  it("surfaces a blocked prompt instead of returning empty text", async () => {
    mockFetch(async () => sse([{ promptFeedback: { blockReason: "SAFETY" } }]));
    await expect(
      new GeminiEngine(KEY, "gemini-3.8-flash").complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/blocked this request \(SAFETY\)/);
  });

  it("tts() maps OpenAI voice names, wraps PCM in WAV and falls through missing models", async () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
    const fetchMock = mockFetch(async (url) =>
      url.includes("gemini-3.8-flash-tts")
        ? json({ error: { code: 404, message: "not found" } }, 404)
        : json({
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: btoa(String.fromCharCode(...pcm)) } }] } },
            ],
          }),
    );
    const blob = await new GeminiEngine(KEY).tts("Hello there", { voice: "alloy", format: "mp3" });
    expect(blob.type).toBe("audio/wav");
    const { format, pcm: out } = parseWav(new Uint8Array(await blob.arrayBuffer()));
    expect(format).toEqual({ sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    expect([...out]).toEqual([...pcm]);

    expect(fetchMock.mock.calls[1][0]).toContain("/models/gemini-3.8-flash-lite-tts:generateContent");
    const body = bodyOf(fetchMock.mock.calls[1][1]);
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
  });

  it("transcribe() sends small mp3 inline and decodes other containers into WAV pieces", async () => {
    let n = 0;
    const fetchMock = mockFetch(async () => json(answer(`part${++n}`)));
    const decode = vi.fn(async () => ({ sampleRate: 16000, channels: [new Float32Array(16000 * 60)] }));
    const engine = new GeminiEngine(KEY, "gemini-3.8-flash", {}, { audioDecoder: decode });

    const mp3 = await engine.transcribe(new Blob([new Uint8Array(1000)], { type: "audio/mpeg" }));
    expect(mp3.text).toBe("part1");
    expect(decode).not.toHaveBeenCalled();
    const inline = bodyOf(fetchMock.mock.calls[0][1]).contents[0].parts[0].inlineData;
    expect(inline.mimeType).toBe("audio/mp3");

    const webm = await engine.transcribe(new Blob([new Uint8Array(1000)], { type: "audio/webm;codecs=opus" }));
    expect(decode).toHaveBeenCalledTimes(1);
    expect(webm.text).toBe("part2");
    expect(bodyOf(fetchMock.mock.calls[1][1]).contents[0].parts[0].inlineData.mimeType).toBe("audio/wav");
  });

  it("embed() batches through batchEmbedContents", async () => {
    const fetchMock = mockFetch(async () => json({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }));
    const out = await new GeminiEngine(KEY).embed(["a", "b"]);
    expect(out).toEqual([[1, 2], [3, 4]]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/models/gemini-embedding-001:batchEmbedContents`);
  });

  it("validate() lists models and reports a bad key as auth", async () => {
    mockFetch(async () => json({ error: { code: 400, message: "API key not valid." } }, 400));
    await expect(new GeminiEngine("AIzaBad").validate()).rejects.toMatchObject({ kind: "auth" });
    mockFetch(async () => json({ models: [] }));
    await expect(new GeminiEngine(KEY).validate()).resolves.toBeUndefined();
  });

  it("createEngine() builds a Gemini engine with every capability", () => {
    const engine = createEngine({ mode: "cloud", provider: "gemini", apiKey: KEY });
    expect(engine.provider).toBe("gemini");
    expect(engine.capabilities()).toEqual({
      chat: true,
      transcription: true,
      tts: true,
      embeddings: true,
      vision: true,
      visionPdf: true,
    });
  });
});

describe("pickGeminiDefaults", () => {
  it("prefers the newest stable Flash / Flash-Lite and ignores previews", () => {
    expect(
      pickGeminiDefaults(["gemini-2.5-flash", "gemini-3.10-flash", "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"]),
    ).toEqual({ strong: "gemini-3.10-flash", fast: "gemini-3.5-flash-lite" });
  });

  it("uses the alias, then the strong model, when nothing better is listed", () => {
    expect(pickGeminiDefaults(["gemini-flash-latest"])).toEqual({ strong: "gemini-flash-latest", fast: "gemini-flash-latest" });
    expect(pickGeminiDefaults([])).toEqual({ strong: "gemini-flash-latest", fast: "gemini-flash-latest" });
  });
});
