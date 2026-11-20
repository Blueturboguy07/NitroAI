/* The explainer video's cost, with the pattern of podcast-cost.test.ts: a
   metered stand-in for the gateway at the prices publik charged NitroAI's
   smoke install per token on 2026-11-05 (balanced 2 micros in / 12 out,
   fast 0.2 in / 1.2 out). The script must be ONE call on publik-fast with
   a cap, and the voice (paid per character) must be bounded whatever the
   model returns. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { resilient } from "../engine/resilient";
import { uuid, now } from "../ids";
import type { Engine } from "../engine/types";
import type { Note } from "../types";
import {
  DEFAULT_VOICES,
  EXPLAINER_LIMITS,
  EXPLAINER_MAX_TOKENS,
  explainerVoiceChars,
  generateExplainerScript,
  synthesizeExplainerAudio,
  tidyExplainerSlides,
} from "./index";

const PRICE = { "publik-balanced": { in: 2, out: 12 }, "publik-fast": { in: 0.2, out: 1.2 } } as const;
const THINKS = { "publik-balanced": 7946, "publik-fast": 30 } as const; // measured reasoning tokens (podcast-cost.test.ts)
const SCRIPT_TOKENS = 1600; // 7 slides: a title, 3 bullets and about 70 words of voice each

afterEach(() => vi.unstubAllGlobals());

const slide = (i: number) => ({ title: `Idea ${i}`, bullets: ["First point", "Second point", "Third point"], narration: `This is what the voice says on slide ${i}. It explains the points.` });

function meteredGateway(slides: unknown[] = Array.from({ length: 7 }, (_, i) => slide(i + 1))) {
  const calls: Array<{ model: keyof typeof PRICE; max_tokens: number; effort?: string; micros: number }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const model = body.model as keyof typeof PRICE;
      const out = THINKS[model] + SCRIPT_TOKENS;
      const finish = out <= body.max_tokens ? "stop" : "length";
      calls.push({ model, max_tokens: body.max_tokens, effort: body.reasoning_effort, micros: Math.round(1414 * PRICE[model].in + Math.min(out, body.max_tokens) * PRICE[model].out) });
      return new Response(JSON.stringify({ choices: [{ message: { content: finish === "stop" ? JSON.stringify({ slides }) : '{"slides": [' }, finish_reason: finish }], usage: { completion_tokens: out } }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const note: Note = { id: uuid(), title: "Candle", sourceKind: "pdf", sourceText: "A candle burns.", blocks: [{ id: uuid(), type: "paragraph", text: "The wick draws up wax." }], createdAt: now(), updatedAt: now(), lastOpenedAt: now() };
const engine = () => resilient(createEngine({ mode: "cloud", provider: "publik", baseUrl: "http://127.0.0.1:41763/api/publik/v1" }));

describe("an explainer script costs well under 1 cent", () => {
  it("one call on publik-fast, effort low, cap 4,000", async () => {
    const calls = meteredGateway();
    const slides = await generateExplainerScript(engine(), note);
    expect(slides).toHaveLength(7);
    expect(slides[0]).toEqual(slide(1));
    expect(EXPLAINER_MAX_TOKENS).toBe(4000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "publik-fast", max_tokens: 4000, effort: "low" });
    expect(calls[0].micros).toBeLessThan(10_000); // 1 cent = 10,000 micros
  });

  it("no usable slide: an error in words, not an empty video", async () => {
    meteredGateway([{ title: "", bullets: [], narration: "" }]);
    await expect(generateExplainerScript(engine(), note)).rejects.toThrow("The model returned no slides. Try again.");
  });
});

describe("the voice is bounded, whatever the model returns", () => {
  it("at most 8 slides, 4 bullets, and 600 characters of voice per slide: 4,800 characters in all", () => {
    const long = "This sentence is here to be long. ".repeat(60); // 2,040 characters
    const raw = Array.from({ length: 20 }, (_, i) => ({ title: `**Title** ${i} ` + "x".repeat(200), bullets: Array.from({ length: 9 }, (_, j) => `- point ${j} ` + "y ".repeat(200)), narration: long }));
    const slides = tidyExplainerSlides(raw);
    expect(slides).toHaveLength(EXPLAINER_LIMITS.slides);
    for (const s of slides) {
      expect(s.title.length).toBeLessThanOrEqual(EXPLAINER_LIMITS.titleChars + 1);
      expect(s.title).not.toContain("*");
      expect(s.bullets).toHaveLength(EXPLAINER_LIMITS.bullets);
      for (const b of s.bullets) expect(b.length).toBeLessThanOrEqual(EXPLAINER_LIMITS.bulletChars + 1);
      expect(s.narration.length).toBeLessThanOrEqual(EXPLAINER_LIMITS.narrationChars);
      expect(s.narration.endsWith(".")).toBe(true); // cut at the end of a sentence
    }
    expect(explainerVoiceChars(slides)).toBeLessThanOrEqual(4800);
    // At OpenAI's list price for tts-1 ($15 per 1,000,000 characters) that is at most 7.2 cents.
    expect((explainerVoiceChars(slides) / 1_000_000) * 15).toBeLessThanOrEqual(0.072);
  });

  it("things that are not slides are dropped", () => {
    expect(tidyExplainerSlides(null)).toEqual([]);
    expect(tidyExplainerSlides("slides")).toEqual([]);
    expect(tidyExplainerSlides([null, 4, {}, { title: "T" }, { narration: "N" }, { title: " A  title ", bullets: "x", narration: "Said\nout loud." }])).toEqual([
      { title: "A title", bullets: [], narration: "Said out loud." },
    ]);
  });

  it("one text-to-speech call per slide, in order, with the podcast's host voice, as mp3", async () => {
    const said: Array<{ text: string; voice: string; format?: string }> = [];
    const fake = { tts: async (text: string, opts: { voice: string; format?: string }) => (said.push({ text, voice: opts.voice, format: opts.format }), new Blob([text])) } as unknown as Engine;
    const steps: string[] = [];
    const slides = [slide(1), slide(2), slide(3)];
    const clips = await synthesizeExplainerAudio(fake, slides, { onSlide: (done, total) => steps.push(`${done}/${total}`) });
    expect(clips).toHaveLength(3);
    expect(said).toEqual(slides.map((s) => ({ text: s.narration, voice: DEFAULT_VOICES.host, format: "mp3" })));
    expect(steps).toEqual(["0/3", "1/3", "2/3"]);
  });
});
