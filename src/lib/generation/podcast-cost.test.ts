/* Round 9, item 3. NitroAI 0.2.3 release smoke test, 2026-11-05: a "Short"
   podcast script went to publik-balanced (xiaomi/mimo-v2.6-pro), which
   thought for 7,946 tokens although reasoning_effort was "low": 10,163
   output tokens, 124,784 micros ($0.125) and 3 min 28 s for 2,217 tokens of
   script. The script now goes to publik-fast (z-ai/glm-5.3-flash, about 30
   reasoning tokens at most in NitroAI's own traffic) with a cap per length.
   Prices below are what publik charged NitroAI's smoke install per token on
   2026-11-05 (prod publik_usage_events): balanced 2 micros in / 12 out,
   fast 0.2 in / 1.2 out. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { resilient } from "../engine/resilient";
import { uuid, now } from "../ids";
import type { Note } from "../types";
import { generatePodcastScript, PODCAST_MAX_TOKENS } from "./index";

const PRICE = { "publik-balanced": { in: 2, out: 12 }, "publik-fast": { in: 0.2, out: 1.2 } } as const;
const THINKS = { "publik-balanced": 7946, "publik-fast": 30 } as const; // measured reasoning tokens
const SCRIPT_TOKENS = 2217; // the measured Short script

afterEach(() => vi.unstubAllGlobals());

function meteredGateway() {
  const calls: Array<{ model: keyof typeof PRICE; max_tokens: number; effort?: string; micros: number }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const model = body.model as keyof typeof PRICE;
      const out = THINKS[model] + SCRIPT_TOKENS;
      const finish = out <= body.max_tokens ? "stop" : "length";
      calls.push({ model, max_tokens: body.max_tokens, effort: body.reasoning_effort, micros: Math.round(1414 * PRICE[model].in + Math.min(out, body.max_tokens) * PRICE[model].out) });
      const lines = Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? "guest" : "host", text: `Line ${i}`, spoken: `Line ${i}` }));
      return new Response(JSON.stringify({ choices: [{ message: { content: finish === "stop" ? JSON.stringify({ lines }) : '{"lines": [' }, finish_reason: finish }], usage: { completion_tokens: out } }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const note: Note = { id: uuid(), title: "Candle", sourceKind: "text", sourceText: "A candle burns.", blocks: [{ id: uuid(), type: "paragraph", text: "The wick draws up wax." }], createdAt: now(), updatedAt: now(), lastOpenedAt: now() };
const engine = () => resilient(createEngine({ mode: "cloud", provider: "publik", baseUrl: "http://127.0.0.1:41763/api/publik/v1" }));

describe("a Short podcast script costs cents, not $0.125", () => {
  it("one call on publik-fast, effort low, cap 6,000; under 1 cent at the measured prices (was 124,784 micros)", async () => {
    const calls = meteredGateway();
    const p = await generatePodcastScript(engine(), note, "short");
    expect(p.script).toHaveLength(12);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "publik-fast", max_tokens: 6000, effort: "low" });
    expect(calls[0].micros).toBeLessThan(10_000);
  });

  it("medium and long keep room for 2 and 3.5 times the turns", async () => {
    expect(PODCAST_MAX_TOKENS).toEqual({ short: 6000, medium: 10000, long: 16000 });
    const calls = meteredGateway();
    await generatePodcastScript(engine(), note, "medium");
    await generatePodcastScript(engine(), note, "long");
    expect(calls.map((c) => `${c.model}:${c.max_tokens}`)).toEqual(["publik-fast:10000", "publik-fast:16000"]);
  });
});
