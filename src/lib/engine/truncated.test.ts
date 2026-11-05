import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEngine } from "./openai";
import { AnthropicEngine } from "./anthropic";
import { LocalEngine } from "./local";
import { EngineError } from "./types";

/* finish_reason "length" (max_tokens reached) must never look like a normal,
   finished answer. On a reasoning model it is often an EMPTY answer: the
   whole cap went to thinking (prod, 2026-09-30: 4,000 of 4,000 tokens). */

function stream(frames: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200, headers },
  );
}
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
/* The error a promise rejects with; fails the test if it resolves. */
async function rejection(p: Promise<unknown>): Promise<EngineError> {
  try {
    await p;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error("expected a rejection");
}
const publik = () => new OpenAIEngine("", undefined, { provider: "publik", baseUrl: "http://127.0.0.1:41763/api/publik/v1" });

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-dialect engine (publik API)", () => {
  it("a stream that spent the whole cap thinking rejects as truncated with no text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          sse({ choices: [{ index: 0, delta: { role: "assistant", reasoning: "Let me think" }, finish_reason: null }] }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
          sse({ choices: [], usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4005 } } }),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const err = await publik().complete({ messages: [{ role: "user", content: "notes" }], maxTokens: 4000 }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.kind).toBe("truncated");
    expect(err.detail.partialText).toBe("");
    expect(err.message).toMatch(/whole length limit on thinking/);
  });

  it("a stream cut mid-answer rejects as truncated and carries the text that arrived", async () => {
    const tokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          sse({ choices: [{ index: 0, delta: { content: "# Notes\n\n- one" }, finish_reason: null }] }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const err = await publik()
      .complete({ messages: [{ role: "user", content: "notes" }] }, (d) => tokens.push(d))
      .catch((e) => e);
    expect(err.kind).toBe("truncated");
    expect(err.detail.partialText).toBe("# Notes\n\n- one");
    expect(tokens.join("")).toBe("# Notes\n\n- one");
  });

  it("a finished stream still resolves with its text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([sse({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"]),
      ),
    );
    await expect(publik().complete({ messages: [{ role: "user", content: "x" }] })).resolves.toBe("done");
  });

  it("reads x-publik-output-capped: the cap publik served to fit the balance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream([sse({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }), "data: [DONE]\n\n"], { "x-publik-output-capped": "1024/16000" })),
    );
    const err = await publik().complete({ messages: [{ role: "user", content: "x" }], maxTokens: 16000 }).catch((e) => e);
    expect(err.detail.cappedTo).toBe(1024);
    expect(err.message).toMatch(/fit your balance/);
  });

  it("sends reasoning_effort on publik when asked, and never to OpenAI itself", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return stream([sse({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"]);
      }),
    );
    await publik().complete({ messages: [{ role: "user", content: "x" }], reasoningEffort: "low", maxTokens: 16000 });
    await new OpenAIEngine("sk-test").complete({ messages: [{ role: "user", content: "x" }], reasoningEffort: "low" });
    expect(bodies[0].reasoning_effort).toBe("low");
    expect(bodies[0].max_tokens).toBe(16000);
    expect(bodies[1].reasoning_effort).toBeUndefined();
  });

  it("structured(): a JSON answer cut at the cap is truncated, not a JSON parse error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"questions":[{"type":"mc' }, finish_reason: "length" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const err = await rejection(publik().structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "quiz" }));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.kind).toBe("truncated");
  });

  it("structured(): broken JSON with a clean stop is a plain EngineError, not a SyntaxError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{oops" }, finish_reason: "stop" }] }), { status: 200 })),
    );
    const err = await rejection(publik().structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "quiz" }));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toMatch(/not complete JSON/);
  });
});

describe("other engines report the cap the same way", () => {
  it("Anthropic: stop_reason max_tokens on a stream is truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          sse({ type: "content_block_delta", delta: { type: "text_delta", text: "# Notes" } }),
          sse({ type: "message_delta", delta: { stop_reason: "max_tokens" } }),
        ]),
      ),
    );
    const err = await new AnthropicEngine("sk-ant-test").complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.kind).toBe("truncated");
    expect(err.detail.partialText).toBe("# Notes");
  });

  it("Anthropic: a tool call cut at max_tokens is truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "tool_use", name: "quiz", input: {} }] }), { status: 200 })),
    );
    const err = await rejection(new AnthropicEngine("sk-ant-test").structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "quiz" }));
    expect(err.kind).toBe("truncated");
  });

  it("Ollama: done_reason length is truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream([JSON.stringify({ message: { content: "# Notes" } }) + "\n", JSON.stringify({ done: true, done_reason: "length" }) + "\n"])),
    );
    const err = await new LocalEngine("http://127.0.0.1:11434").complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.kind).toBe("truncated");
    expect(err.detail.partialText).toBe("# Notes");
  });
});
