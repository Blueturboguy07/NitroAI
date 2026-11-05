/* Round 9, item 1 (the Martin bug class). NitroAI 0.2.3 release smoke test,
   2026-11-05, the Faraday candle lecture (30K chars, two sections + merge):
   - Windows: the MERGE call on publik-balanced (xiaomi/mimo-v2.6-pro via
     OpenRouter) stopped with finish_reason "content_filter" after 3,141
     tokens. The note ended "…the streaming of the ascendingThe request was
     rejected because it was considered high risk", and the end of the
     lecture and the closing sections were missing. No warning.
   - Mac: SECTION 1 stopped the same way; the note was merged as if whole.
   The engine took every finish except "length" as complete. Now only a
   clean "stop" is whole; anything else is "incomplete", gets one more try on
   the other tier (another model and provider), and is never saved as whole
   or with the provider's refusal text in it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { resilient } from "../engine/resilient";
import { AnthropicEngine } from "../engine/anthropic";
import { LocalEngine } from "../engine/local";
import { EngineError, type Engine } from "../engine/types";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import { plainText } from "../markdown";
import { noteReduceSystem, noteSystem, titleSystem } from "../prompts";
import { uuid, now } from "../ids";
import type { Note } from "../types";
import { chatAnswer, generateFlashcards, generateNoteBody, generatePodcastScript, generateQuiz, generateTitle } from "./index";
import { createNoteFromSources } from "./pipeline";

const REFUSAL = "The request was rejected because it was considered high risk";

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  response_format?: { json_schema?: { name?: string } };
}

/* How one call ends. "stop" = whole; "filter" = the content filter stops it
   after `keep` chars and the refusal text arrives as content (as on
   2026-11-05); "nofinish" = the stream ends with no finish_reason; "error" =
   finish_reason "error". */
type Ending = { end: "stop" } | { end: "filter"; keep: number } | { end: "nofinish"; keep: number } | { end: "error"; keep: number };
type Rule = (b: ChatBody) => { content: string; ending?: Ending };

function gateway(byModel: Record<string, Rule>) {
  const sent: ChatBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ChatBody;
      sent.push(body);
      const rule = byModel[body.model];
      if (!rule) throw new Error(`unexpected model ${body.model}`);
      const { content, ending = { end: "stop" } } = rule(body);
      const provider = body.model === "publik-balanced" ? "Xiaomi" : "Z.AI";
      let text = content;
      let finish: string | null = "stop";
      if (ending.end === "filter") {
        text = content.slice(0, ending.keep) + REFUSAL;
        finish = "content_filter";
      } else if (ending.end === "nofinish") {
        text = content.slice(0, ending.keep);
        finish = null;
      } else if (ending.end === "error") {
        text = content.slice(0, ending.keep);
        finish = "error";
      }
      const usage = { prompt_tokens: 100, completion_tokens: Math.ceil(text.length / 4), completion_tokens_details: { reasoning_tokens: 30 } };
      if (!body.stream) {
        return new Response(JSON.stringify({ model: body.model, provider, choices: [{ message: { role: "assistant", content: text }, finish_reason: finish }], usage }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const frames: string[] = [];
      for (let i = 0; i < text.length; i += 300) {
        frames.push(`data: ${JSON.stringify({ provider, model: body.model, choices: [{ index: 0, delta: { content: text.slice(i, i + 300) }, finish_reason: null }] })}\n\n`);
      }
      if (finish) frames.push(`data: ${JSON.stringify({ provider, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      if (finish) frames.push(`data: ${JSON.stringify({ provider, choices: [], usage })}\n\n`);
      if (finish) frames.push("data: [DONE]\n\n");
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(enc.encode(f));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  return sent;
}

function publikEngine(): Engine {
  return resilient(createEngine({ mode: "cloud", provider: "publik", baseUrl: "http://127.0.0.1:41763/api/publik/v1", models: { fast: "publik-fast", strong: "publik-balanced" } }));
}

const userText = (b: ChatBody) => b.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
const system = (b: ChatBody) => b.messages.find((m) => m.role === "system")?.content ?? "";
const isMerge = (b: ChatBody) => system(b) === noteReduceSystem("English");
const isTitle = (b: ChatBody) => system(b) === titleSystem;
const section = (b: ChatBody) => (userText(b).includes("SECTION-B") ? "B" : "A");
const sectionNotes = (b: ChatBody) =>
  section(b) === "B"
    ? "## Lecture part B\n\n" + "- The flame needs air from below. ".repeat(60) + "\n\n## Key Takeaways\n\n- A candle is a chemical machine."
    : "## Lecture part A\n\n" + "- The cup holds the melted fuel. ".repeat(60);
const MERGED = (b: ChatBody) => "# The Chemical History of a Candle\n\n" + userText(b) + "\n\n## Key Vocabulary\n\n- Capillary attraction";
/* Two map chunks (> 6,000 tokens), like the 30K-char Faraday lecture. */
const BIG = "SECTION-A " + "The candle burns because the wick draws melted wax upward. ".repeat(260) + "\n\nSECTION-B " + "The flame is hollow and the air rises around it. ".repeat(260);

function makeNote(over: Partial<Note> = {}): Note {
  return { id: uuid(), title: "The candle", sourceKind: "text", sourceText: "A candle burns.", blocks: [{ id: uuid(), type: "paragraph", text: "The wick draws up the melted wax." }], createdAt: now(), updatedAt: now(), lastOpenedAt: now(), ...over };
}

afterEach(() => vi.unstubAllGlobals());

describe("engine: only a clean finish is a whole answer", () => {
  it("content_filter with the refusal text streamed as content → incomplete; the text has no refusal; the provider is named", async () => {
    gateway({ "publik-balanced": () => ({ content: "The flame is hollow; the streaming of the ascending air", ending: { end: "filter", keep: 46 } }) });
    const err = await publikEngine().complete({ messages: [{ role: "user", content: "x" }], tier: "strong" }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.kind).toBe("incomplete");
    expect(err.detail.finishReason).toBe("content_filter");
    expect(err.detail.partialText).toBe("The flame is hollow; the streaming of the asce");
    expect(err.detail.upstreamProvider).toBe("Xiaomi");
    expect(err.message).not.toMatch(/high risk/);
  });

  it("refusal text with finish_reason stop, a stream with no finish_reason, and finish_reason error are all incomplete", async () => {
    const cases: Array<[Ending | undefined, string, string]> = [
      [{ end: "nofinish", keep: 10 }, "none", "Notes on c"],
      [{ end: "error", keep: 10 }, "error", "Notes on c"],
    ];
    for (const [ending, reason, partial] of cases) {
      gateway({ "publik-balanced": () => ({ content: "Notes on candles.", ending }) });
      const err = await publikEngine().complete({ messages: [{ role: "user", content: "x" }], tier: "strong" }).catch((e) => e);
      expect(err.kind, reason).toBe("incomplete");
      expect(err.detail.finishReason).toBe(reason);
      expect(err.detail.partialText).toBe(partial);
    }
    gateway({ "publik-balanced": () => ({ content: `Notes on candles. ${REFUSAL}.` }) });
    const err = await publikEngine().complete({ messages: [{ role: "user", content: "x" }], tier: "strong" }).catch((e) => e);
    expect(err.kind).toBe("incomplete");
    expect(err.detail.finishReason).toBe("content_filter");
    expect(err.detail.partialText).toBe("Notes on candles.");
  });

  it("structured(): content_filter, an OpenAI `refusal`, and a missing finish_reason are incomplete, not a JSON error", async () => {
    for (const json of [
      { choices: [{ message: { content: '{"questions": [' }, finish_reason: "content_filter" }] },
      { choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] },
      { choices: [{ message: { content: "{}" } }] },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } })));
      const err = (await publikEngine().structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "quiz" }).catch((e) => e)) as EngineError;
      expect(err.kind, JSON.stringify(json)).toBe("incomplete");
    }
  });

  it("Anthropic stop_reason refusal and an Ollama stream with no done:true are incomplete", async () => {
    const sse = (events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal("fetch", vi.fn(async () => sse([{ type: "content_block_delta", delta: { type: "text_delta", text: "Part" } }, { type: "message_delta", delta: { stop_reason: "refusal" } }])));
    const a = await new AnthropicEngine("sk-ant-x").complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(a.kind).toBe("incomplete");
    expect(a.detail.finishReason).toBe("refusal");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${JSON.stringify({ message: { content: "Half" }, done: false })}\n`)));
    const o = await new LocalEngine().complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(o.kind).toBe("incomplete");
    expect(o.detail.finishReason).toBe("none");
  });

  it("stripRefusal takes only a provider message at the end", async () => {
    const { stripRefusal } = await import("../engine/refusal");
    expect(stripRefusal(`…the streaming of the ascending${REFUSAL}`)).toEqual({ text: "…the streaming of the ascending", refusal: REFUSAL });
    expect(stripRefusal(`Notes.\n\n${REFUSAL.toLowerCase()}.\n`).refusal).toBe(REFUSAL);
    expect(stripRefusal("Input data may contain inappropriate content.").text).toBe("");
    expect(stripRefusal("系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。").refusal).not.toBeNull();
    // Not at the end: real content that quotes it stays.
    const quote = `The provider said "${REFUSAL}" and then the lecture went on about wax.`;
    expect(stripRefusal(quote)).toEqual({ text: quote, refusal: null });
    expect(stripRefusal("Plain notes.")).toEqual({ text: "Plain notes.", refusal: null });
  });
});

describe("notes: a filtered call is retried on the other tier; a note is never saved with refusal text or as whole when it is not", () => {
  it("Windows case: the merge is filtered on publik-balanced → retried on publik-fast → the whole note, no refusal text", async () => {
    const sent = gateway({
      "publik-balanced": (b) => (isMerge(b) ? { content: MERGED(b), ending: { end: "filter", keep: 900 } } : { content: sectionNotes(b) }),
      "publik-fast": (b) => (isMerge(b) ? { content: MERGED(b) } : { content: "unused" }),
    });
    const text = plainText(await generateNoteBody(publikEngine(), BIG, "English"));
    expect(text).toContain("The Chemical History of a Candle");
    expect(text).toContain("A candle is a chemical machine.");
    expect(text).toContain("Capillary attraction");
    expect(text).not.toMatch(/high risk/i);
    expect(text).not.toMatch(/not complete|stops early/);
    expect(sent.filter(isMerge).map((b) => b.model)).toEqual(["publik-balanced", "publik-fast"]);
  });

  it("Mac case: section 1 is filtered → retried on publik-fast → whole, so the merge still runs", async () => {
    const sent = gateway({
      "publik-balanced": (b) => (isMerge(b) ? { content: MERGED(b) } : section(b) === "A" ? { content: sectionNotes(b), ending: { end: "filter", keep: 700 } } : { content: sectionNotes(b) }),
      "publik-fast": (b) => ({ content: sectionNotes(b) }),
    });
    const text = plainText(await generateNoteBody(publikEngine(), BIG, "English"));
    expect(text).toContain("The cup holds the melted fuel.");
    expect(text).toContain("Capillary attraction");
    expect(text).not.toMatch(/high risk/i);
    expect(sent.map((b) => `${b.model}:${isMerge(b) ? "merge" : section(b)}`)).toEqual(["publik-balanced:A", "publik-fast:A", "publik-balanced:B", "publik-balanced:merge"]);
  });

  it("a section filtered on BOTH tiers: kept up to the stop, a warning at the top and at the stop names the section and the filter; no merge", async () => {
    const sent = gateway({
      "publik-balanced": (b) => (section(b) === "A" && !isMerge(b) ? { content: sectionNotes(b), ending: { end: "filter", keep: 600 } } : { content: isMerge(b) ? MERGED(b) : sectionNotes(b) }),
      "publik-fast": (b) => ({ content: sectionNotes(b), ending: { end: "filter", keep: 300 } }),
    });
    const blocks = await generateNoteBody(publikEngine(), BIG, "English");
    const text = plainText(blocks);
    expect(blocks[0].type).toBe("callout");
    expect(plainText([blocks[0]])).toMatch(/This note is not complete\. Section 1 of 2 stops early: the AI provider's safety filter stopped it, also on a second AI model\./);
    expect(text).toMatch(/Section 1 of 2 stops early: the AI provider's safety filter stopped it, also on a second AI model\. The rest of this section is missing\./);
    expect(text).toContain("The cup holds the melted fuel."); // the longer partial text (balanced) is kept
    expect(text).toContain("A candle is a chemical machine."); // section 2 is whole
    expect(text).not.toMatch(/high risk/i);
    expect(sent.some(isMerge)).toBe(false); // a note with a gap is never merged as if whole
  });

  it("a merge filtered on both tiers keeps the whole section notes (nothing lost, no refusal text, no partial merge)", async () => {
    gateway({
      "publik-balanced": (b) => (isMerge(b) ? { content: MERGED(b), ending: { end: "filter", keep: 500 } } : { content: sectionNotes(b) }),
      "publik-fast": (b) => ({ content: MERGED(b), ending: { end: "filter", keep: 200 } }),
    });
    const text = plainText(await generateNoteBody(publikEngine(), BIG, "English"));
    expect(text).toContain("The cup holds the melted fuel.");
    expect(text).toContain("A candle is a chemical machine.");
    expect(text).not.toContain("The Chemical History of a Candle");
    expect(text).not.toMatch(/high risk/i);
  });

  it("a short note filtered on both tiers with no text: nothing is saved, and the job says the safety filter stopped it", async () => {
    gateway({
      "publik-balanced": (b) => (system(b) === noteSystem("English") ? { content: "# Notes", ending: { end: "filter", keep: 0 } } : { content: "Candle" }),
      "publik-fast": (b) => (system(b) === noteSystem("English") ? { content: "# Notes", ending: { end: "filter", keep: 0 } } : { content: "Candle" }),
    });
    const repo = new Repo(memoryStore());
    const jobs: string[] = [];
    const run = createNoteFromSources({ repo, engine: publikEngine(), inputs: [{ kind: "text", text: "A candle burns." }], onProgress: (j) => jobs.push(`${j.status}:${j.message}`) });
    await expect(run).rejects.toMatchObject({ kind: "incomplete" });
    await expect(run).rejects.toThrow("No note was saved: the AI provider's safety filter stopped it, also on a second AI model, and it wrote no text.");
    expect(await repo.listNotes()).toHaveLength(0);
    expect(jobs.at(-1)).toMatch(/^error:No note was saved: the AI provider's safety filter/);
  });

  it("the whole pipeline: the saved note of the Windows case has no refusal text, and a filtered title falls back without it", async () => {
    gateway({
      "publik-balanced": (b) => (isMerge(b) ? { content: MERGED(b), ending: { end: "filter", keep: 900 } } : isTitle(b) ? { content: "Candle", ending: { end: "filter", keep: 3 } } : { content: sectionNotes(b) }),
      "publik-fast": (b) => (isMerge(b) ? { content: MERGED(b) } : isTitle(b) ? { content: "Candle Lecture", ending: { end: "filter", keep: 4 } } : { content: "unused" }),
    });
    const repo = new Repo(memoryStore());
    const id = await createNoteFromSources({ repo, engine: publikEngine(), inputs: [{ kind: "text", text: BIG, filename: "faraday-candle-lecture1.txt" }] });
    const note = (await repo.getNote(id))!;
    expect(JSON.stringify(note.blocks)).not.toMatch(/high risk/i);
    expect(plainText(note.blocks)).toContain("Capillary attraction");
    expect(note.title).not.toMatch(/high risk/i);
  });

  it("a stream that ends with no finish_reason is retried too", async () => {
    const sent = gateway({
      "publik-balanced": (b) => (isMerge(b) ? { content: MERGED(b), ending: { end: "nofinish", keep: 400 } } : { content: sectionNotes(b) }),
      "publik-fast": (b) => ({ content: MERGED(b) }),
    });
    const text = plainText(await generateNoteBody(publikEngine(), BIG, "English"));
    expect(text).toContain("Capillary attraction");
    expect(sent.filter(isMerge)).toHaveLength(2);
  });
});

describe("every other generation path follows the same rule", () => {
  it("title: filtered on publik-fast → retried on publik-balanced", async () => {
    const sent = gateway({ "publik-fast": () => ({ content: "Candle", ending: { end: "filter", keep: 2 } }), "publik-balanced": () => ({ content: "The Chemistry of a Candle" }) });
    expect(await generateTitle(publikEngine(), "A candle burns.")).toBe("The Chemistry of a Candle");
    expect(sent.map((b) => b.model)).toEqual(["publik-fast", "publik-balanced"]);
    gateway({ "publik-fast": () => ({ content: "Candle", ending: { end: "filter", keep: 2 } }), "publik-balanced": () => ({ content: "Candle", ending: { end: "filter", keep: 3 } }) });
    await expect(generateTitle(publikEngine(), "A candle burns.")).rejects.toMatchObject({ kind: "incomplete" });
  });

  const quizJson = JSON.stringify({ questions: [{ type: "mcq", question: "What rises?", options: ["Air", "Wax"], answer: "Air", explanation: "Heat.", topic: "Flame" }] });
  const cardsJson = JSON.stringify({ cards: [{ front: "Wick?", back: "Draws up **wax**.", topic: "Wick" }] });
  const podJson = JSON.stringify({ lines: [{ speaker: "host", text: "Hi.", spoken: "Hi." }] });

  it("quiz, flashcards and podcast: filtered → retried on the other tier → saved", async () => {
    const sent = gateway({
      "publik-balanced": (b) => {
        const n = b.response_format?.json_schema?.name;
        if (n === "quiz" || n === "flashcards") return { content: n === "quiz" ? quizJson : cardsJson, ending: { end: "filter", keep: 20 } };
        return { content: n === "podcast" ? podJson : JSON.stringify({ topics: ["Wick"] }) };
      },
      "publik-fast": (b) => {
        const n = b.response_format?.json_schema?.name;
        if (n === "podcast" || n === "topics") return { content: n === "podcast" ? podJson : JSON.stringify({ topics: ["Wick"] }), ending: n === "podcast" ? { end: "filter", keep: 10 } : { end: "stop" } };
        return { content: n === "quiz" ? quizJson : cardsJson };
      },
    });
    expect((await generateQuiz(publikEngine(), makeNote()))[0].question).toBe("What rises?");
    expect((await generateFlashcards(publikEngine(), makeNote()))[0].back).toBe("Draws up **wax**.");
    expect((await generatePodcastScript(publikEngine(), makeNote(), "short")).script[0].text).toBe("Hi.");
    expect(sent.map((b) => `${b.response_format?.json_schema?.name}:${b.model}`)).toEqual([
      "quiz:publik-balanced",
      "quiz:publik-fast",
      "topics:publik-fast",
      "flashcards:publik-balanced",
      "flashcards:publik-fast",
      "podcast:publik-fast",
      "podcast:publik-balanced",
    ]);
  });

  it("quiz filtered on both tiers: nothing saved, the words say why", async () => {
    gateway({ "publik-balanced": () => ({ content: quizJson, ending: { end: "filter", keep: 5 } }), "publik-fast": () => ({ content: quizJson, ending: { end: "filter", keep: 5 } }) });
    const err = await generateQuiz(publikEngine(), makeNote()).catch((e) => e);
    expect(err.kind).toBe("incomplete");
    expect(err.message).toBe("No quiz was saved: the AI provider's safety filter stopped it, also on a second AI model. Try again. If it stops again, try a different note.");
  });

  it("assistant: filtered → the stream restarts on the other tier; on both, the partial answer says it stops early, with no refusal text", async () => {
    gateway({ "publik-balanced": () => ({ content: "The wick draws up wax.", ending: { end: "filter", keep: 9 } }), "publik-fast": () => ({ content: "The wick draws up melted wax by capillary action." }) });
    let shown = "";
    let restarts = 0;
    const answer = await chatAnswer(publikEngine(), makeNote(), [], "What does the wick do?", (d) => (shown += d), () => {
      restarts++;
      shown = "";
    });
    expect(answer).toBe("The wick draws up melted wax by capillary action.");
    expect(shown).toBe(answer);
    expect(restarts).toBe(1);

    gateway({ "publik-balanced": () => ({ content: "The wick draws up wax.", ending: { end: "filter", keep: 9 } }), "publik-fast": () => ({ content: "The wick draws up wax.", ending: { end: "filter", keep: 5 } }) });
    const partial = await chatAnswer(publikEngine(), makeNote(), [], "What does the wick do?");
    expect(partial).toBe("The wick\n\n_This answer stops early: the AI provider's safety filter stopped it, also on a second AI model._");
    expect(partial).not.toMatch(/high risk/i);
  });
});
