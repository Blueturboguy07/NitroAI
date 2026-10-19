import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiEngine } from "./gemini";
import { OpenAIEngine } from "./openai";
import { AnthropicEngine } from "./anthropic";
import { LocalEngine } from "./local";
import { resilient } from "./resilient";
import { supportsTask, unsupportedMessage } from "./router";
import { isLocalVisionModel, READ_DOCUMENT_PROMPT } from "./vision";
import { EngineError, type Engine } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200 });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const bodyOf = (fn: ReturnType<typeof stubFetch>, i = 0) => JSON.parse(fn.mock.calls[i][1]?.body as string);

const pdf = { mimeType: "application/pdf", data: new Blob(["%PDF-1.4"], { type: "application/pdf" }) };
const png = { mimeType: "image/png", data: new Blob(["png-bytes"], { type: "image/png" }) };

afterEach(() => vi.unstubAllGlobals());

describe("Engine.readDocument", () => {
  it("Gemini sends a PDF inline with the reading prompt", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: " Slide 1: Mitosis " }] }, finishReason: "STOP" }] }),
    );
    const text = await new GeminiEngine("AIza-test", "gemini-test").readDocument([pdf]);
    expect(text).toBe("Slide 1: Mitosis");
    expect(fetchMock.mock.calls[0][0]).toContain("/models/gemini-test:generateContent");
    const parts = bodyOf(fetchMock).contents[0].parts;
    expect(parts[0].inlineData).toEqual({ mimeType: "application/pdf", data: btoa("%PDF-1.4") });
    expect(parts[1].text).toBe(READ_DOCUMENT_PROMPT);
  });

  it("Gemini returns '' for pages with no text, but reports a blocked answer", async () => {
    stubFetch(() => jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }));
    await expect(new GeminiEngine("AIza-test", "gemini-test").readDocument([png])).resolves.toBe("");
    stubFetch(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(new GeminiEngine("AIza-test", "gemini-test").readDocument([png])).rejects.toThrow(/blocked/);
  });

  it("OpenAI sends page images as data URLs and refuses a whole PDF", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ choices: [{ message: { content: "Page text" } }] }));
    const engine = new OpenAIEngine("sk-test");
    expect(await engine.readDocument([png])).toBe("Page text");
    const body = bodyOf(fetchMock);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages[0].content[0]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${btoa("png-bytes")}`, detail: "high" },
    });
    await expect(engine.readDocument([pdf])).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("OpenAI as publik refuses before any fetch when the credential has no vision line", async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));
    const engine = new OpenAIEngine("", undefined, {
      provider: "publik",
      capabilities: { chat: true, transcription: false, tts: false, embeddings: false, vision: false },
    });
    await expect(engine.readDocument([png])).rejects.toBeInstanceOf(EngineError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Anthropic sends a PDF as a document block and streams the answer", async () => {
    const fetchMock = stubFetch(() =>
      sse([
        { type: "content_block_delta", delta: { type: "text_delta", text: "Cell " } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "cycle" } },
      ]),
    );
    expect(await new AnthropicEngine("sk-ant-test").readDocument([pdf])).toBe("Cell cycle");
    const body = bodyOf(fetchMock);
    expect(body.stream).toBe(true);
    expect(body.messages[0].content[0]).toMatchObject({
      type: "document",
      source: { type: "base64", media_type: "application/pdf" },
    });
  });

  it("Local reads images only with a vision model", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ message: { content: "Local text" } }));
    expect(new LocalEngine(undefined, "qwen2.5:3b").capabilities().vision).toBe(false);
    await expect(new LocalEngine(undefined, "qwen2.5:3b").readDocument([png])).rejects.toMatchObject({
      kind: "unsupported",
    });
    const vision = new LocalEngine(undefined, "qwen2.5vl:7b");
    expect(vision.capabilities().vision).toBe(true);
    expect(await vision.readDocument([png])).toBe("Local text");
    expect(bodyOf(fetchMock).messages[0].images).toEqual([btoa("png-bytes")]);
  });

  it("recognises common Ollama vision models by name", () => {
    for (const m of ["llava:13b", "llama3.2-vision", "qwen2.5vl:7b", "gemma3:4b", "minicpm-v", "moondream"]) {
      expect(isLocalVisionModel(m)).toBe(true);
    }
    for (const m of ["qwen2.5:3b", "llama3.1:8b", "gemma3n:e4b", "mistral"]) {
      expect(isLocalVisionModel(m)).toBe(false);
    }
  });
});

describe("vision routing", () => {
  const base: Engine = {
    mode: "cloud",
    capabilities: () => ({ chat: true, transcription: false, tts: false, embeddings: false, vision: true }),
    complete: async () => "",
    structured: async () => ({}) as never,
    transcribe: async () => ({ text: "", segments: [] }),
    tts: async () => new Blob(),
    embed: async () => [],
    validate: async () => {},
  };

  it("needs both the capability flag and the method", () => {
    expect(supportsTask(base, "vision")).toBe(false);
    expect(supportsTask({ ...base, readDocument: async () => "x" }, "vision")).toBe(true);
    expect(
      supportsTask({ ...base, capabilities: () => ({ ...base.capabilities(), vision: false }), readDocument: async () => "x" }, "vision"),
    ).toBe(false);
  });

  it("resilient() forwards readDocument (with retries) only when the engine has it", async () => {
    vi.useFakeTimers();
    let n = 0;
    const wrapped = resilient({
      ...base,
      readDocument: async () => {
        if (++n < 2) throw new EngineError("429", "rate_limit");
        return "read";
      },
    });
    expect(supportsTask(wrapped, "vision")).toBe(true);
    const p = wrapped.readDocument!([png]);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("read");
    expect(n).toBe(2);
    vi.useRealTimers();
    expect(resilient(base).readDocument).toBeUndefined();
  });

  it("explains what to do when the engine can't read images", () => {
    expect(unsupportedMessage("vision")).toMatch(/Gemini, OpenAI or Anthropic key/);
    expect(unsupportedMessage("vision", "publik")).toMatch(/your own Gemini, OpenAI or Anthropic key/);
  });
});

describe("LocalEngine error mapping", () => {
  it("maps an Ollama 404 to 'model not downloaded' instead of 'not reachable'", async () => {
    stubFetch(() => jsonResponse({ error: "model 'llama9' not found, try pulling it first" }, 404));
    await expect(new LocalEngine(undefined, "llama9").complete({ messages: [] })).rejects.toMatchObject({
      kind: "model_missing",
      message: expect.stringContaining("llama9"),
    });
  });

  it("surfaces other Ollama errors verbatim and sends a real context window", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ error: "out of memory" }, 500));
    await expect(new LocalEngine().complete({ messages: [] })).rejects.toThrow("Ollama: out of memory");
    expect(bodyOf(fetchMock).options.num_ctx).toBe(16384);
  });
});
