import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import { resilient } from "../engine/resilient";
import { EngineError, type Engine } from "../engine/types";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import { plainText } from "../markdown";
import { noteReduceSystem, noteSystem, titleSystem } from "../prompts";
import { uuid, now } from "../ids";
import type { Note } from "../types";
import { chatAnswer, generateNoteBody, generateQuiz, generateTitle } from "./index";
import { createNoteFromSources } from "./pipeline";

/* publik API in front of a REASONING model, the way it behaves in prod
   (xiaomi/mimo-v2.6-pro behind publik-balanced, z-ai/glm-5.3-flash behind
   publik-fast): the model thinks first, and the thinking counts against the
   same max_tokens as the answer. When the cap runs out the stream ends with
   finish_reason "length" — with no text at all if it ran out while thinking.
   An absent max_tokens gets the gateway default, 8,192. */
interface Behaviour {
  reasoning: number; // tokens spent thinking before the first word
  content: string; // the full answer it would write (4 chars ≈ 1 token)
}
type Script = (body: ChatBody) => Behaviour;
interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  reasoning_effort?: string;
}

const GATEWAY_DEFAULT_CAP = 8192;

function reasoningGateway(byModel: Record<string, Script>, headers: Record<string, string> = {}) {
  const sent: ChatBody[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ChatBody;
    sent.push(body);
    const script = byModel[body.model];
    if (!script) throw new Error(`unexpected model ${body.model}`);
    const { reasoning, content } = script(body);
    const cap = body.max_tokens ?? GATEWAY_DEFAULT_CAP;
    const contentTokens = Math.ceil(content.length / 4);
    let text: string;
    let finish: "stop" | "length";
    if (cap <= reasoning) {
      text = "";
      finish = "length";
    } else if (cap < reasoning + contentTokens) {
      text = content.slice(0, (cap - reasoning) * 4);
      finish = "length";
    } else {
      text = content;
      finish = "stop";
    }
    const usage = { prompt_tokens: 100, completion_tokens: Math.min(cap, reasoning + contentTokens), completion_tokens_details: { reasoning_tokens: Math.min(cap, reasoning) } };
    if (!body.stream) {
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: text }, finish_reason: finish }], usage }), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });
    }
    const frames: string[] = [];
    frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", reasoning: "thinking…" }, finish_reason: null }] })}\n\n`);
    for (let i = 0; i < text.length; i += 400) {
      frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(i, i + 400) }, finish_reason: null }] })}\n\n`);
    }
    frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
    frames.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    frames.push("data: [DONE]\n\n");
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of frames) c.enqueue(enc.encode(f));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream", ...headers } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return sent;
}

/* The publik engine exactly as app.tsx builds it (resilient + publik aliases). */
function publikEngine(): Engine {
  return resilient(
    createEngine({
      mode: "cloud",
      provider: "publik",
      baseUrl: "http://127.0.0.1:41763/api/publik/v1",
      models: { fast: "publik-fast", strong: "publik-balanced" },
    }),
  );
}

const userText = (b: ChatBody) => b.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
const sectionNotes = (b: ChatBody) => (userText(b).includes("SECTION-B") ? "## Part B\n\n" + "- Calvin cycle detail B. ".repeat(300) : "## Part A\n\n" + "- Light reaction detail A. ".repeat(300));
/* Two map chunks: a ~62k-char lecture, like the source of the 2026-09-30 note. */
const BIG = "SECTION-A " + "Photosynthesis is the core process of plants. ".repeat(500) + "\n\nSECTION-B " + "The Calvin cycle fixes carbon in the stroma. ".repeat(500);

function makeNote(over: Partial<Note> = {}): Note {
  return { id: uuid(), title: "Photosynthesis", sourceKind: "text", sourceText: "Plants convert light into sugar.", blocks: [], createdAt: now(), updatedAt: now(), lastOpenedAt: now(), ...over };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notes on a reasoning model (publik-balanced spends its cap thinking)", () => {
  it("a long document whose sections think for 4,005 tokens (the 2026-09-30 note) comes back with every section's notes", async () => {
    const sent = reasoningGateway({
      "publik-balanced": (b) =>
        b.messages[0].content === noteReduceSystem("English")
          ? { reasoning: 300, content: "# Photosynthesis\n\n" + userText(b) }
          : { reasoning: 4005, content: sectionNotes(b) },
      "publik-fast": (b) => ({ reasoning: 31, content: sectionNotes(b) }),
    });

    const blocks = await generateNoteBody(publikEngine(), BIG, "English");
    const text = plainText(blocks);

    expect(text).toContain("Light reaction detail A.");
    expect(text).toContain("Calvin cycle detail B.");
    // No request ever carried an empty source (the old code merged two empty sections).
    for (const b of sent) expect(userText(b).trim().length).toBeGreaterThan(20);
    // Every note request leaves room to think, and asks to think briefly.
    for (const b of sent) {
      expect(b.max_tokens).toBeGreaterThanOrEqual(12000);
      expect(b.reasoning_effort).toBe("low");
    }
  });

  it("a section that thinks past even the new cap is written by publik-fast instead of being dropped", async () => {
    const sent = reasoningGateway({
      "publik-balanced": (b) =>
        b.messages[0].content === noteReduceSystem("English")
          ? { reasoning: 300, content: "# Photosynthesis\n\n" + userText(b) }
          : { reasoning: 50_000, content: sectionNotes(b) },
      "publik-fast": (b) => ({ reasoning: 31, content: sectionNotes(b) }),
    });

    const text = plainText(await generateNoteBody(publikEngine(), BIG, "English"));

    expect(text).toContain("Light reaction detail A.");
    expect(text).toContain("Calvin cycle detail B.");
    const fast = sent.filter((b) => b.model === "publik-fast");
    expect(fast).toHaveLength(2); // one retry per empty section, same cap
    expect(fast[0].max_tokens).toBe(sent[0].max_tokens);
  });

  it("a short source that comes back empty is retried on publik-fast", async () => {
    reasoningGateway({
      "publik-balanced": () => ({ reasoning: 50_000, content: "# Notes\n\n- never written" }),
      "publik-fast": () => ({ reasoning: 31, content: "# Notes\n\n- Plants make sugar from light." }),
    });
    const text = plainText(await generateNoteBody(publikEngine(), "Plants convert light into sugar.", "English"));
    expect(text).toContain("Plants make sugar from light.");
  });

  it("when no tier writes anything, no note is saved and the job says why", async () => {
    reasoningGateway({
      "publik-balanced": () => ({ reasoning: 50_000, content: "# never" }),
      "publik-fast": () => ({ reasoning: 50_000, content: "# never" }),
    });
    const repo = new Repo(memoryStore());
    const jobs: string[] = [];

    const run = createNoteFromSources({
      repo,
      engine: publikEngine(),
      inputs: [{ kind: "text", text: "Plants convert light into sugar." }],
      onProgress: (j) => jobs.push(`${j.status}:${j.message}`),
    });

    await expect(run).rejects.toMatchObject({ kind: "truncated" });
    await expect(run).rejects.toThrow(/No note was saved/);
    expect(await repo.listNotes()).toHaveLength(0);
    expect(jobs.at(-1)).toMatch(/^error:.*length limit/);
  });

  it("a section cut at the cap keeps its text and says in the note that it stops early", async () => {
    reasoningGateway({
      "publik-balanced": () => ({ reasoning: 500, content: "# Notes\n\n" + "- A very long point about light. ".repeat(4000) }),
      "publik-fast": () => ({ reasoning: 31, content: "# unused" }),
    });
    const blocks = await generateNoteBody(publikEngine(), "Plants convert light into sugar.", "English");
    expect(plainText(blocks)).toContain("A very long point about light.");
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("callout");
    expect(plainText([last])).toMatch(/These notes stop early/);
  });

  it("an open code block at the cut is closed so the notice is not swallowed by it", async () => {
    reasoningGateway({
      "publik-balanced": () => ({ reasoning: 500, content: "# Notes\n\n```python\n" + "x = 1\n".repeat(20000) + "```\n" }),
      "publik-fast": () => ({ reasoning: 31, content: "# unused" }),
    });
    const blocks = await generateNoteBody(publikEngine(), "Some code.", "English");
    expect(blocks[blocks.length - 1].type).toBe("callout");
  });

  it("says when publik lowered the cap to fit the balance", async () => {
    reasoningGateway(
      {
        "publik-balanced": () => ({ reasoning: 50_000, content: "# never" }),
        "publik-fast": () => ({ reasoning: 50_000, content: "# never" }),
      },
      { "x-publik-output-capped": "1024/16000" },
    );
    await expect(generateNoteBody(publikEngine(), "Plants.", "English")).rejects.toThrow(/lowered the length limit to fit your balance/);
  });
});

describe("the other call paths on a reasoning model", () => {
  it("the title gets room to think: a model that thinks 30 tokens still names the note", async () => {
    const sent = reasoningGateway({
      "publik-fast": (b) => (b.messages[0].content === titleSystem ? { reasoning: 30, content: "Carbon Fixation and the Calvin Cycle" } : { reasoning: 0, content: "" }),
    });
    expect(await generateTitle(publikEngine(), "The Calvin cycle fixes carbon.")).toBe("Carbon Fixation and the Calvin Cycle");
    expect(sent[0].max_tokens).toBeGreaterThanOrEqual(1000);
  });

  it("a chat answer that thinks past the gateway default still arrives", async () => {
    reasoningGateway({
      "publik-balanced": () => ({ reasoning: 9000, content: "RuBisCO fixes CO2 onto RuBP." }),
      "publik-fast": () => ({ reasoning: 31, content: "unused" }),
    });
    const answer = await chatAnswer(publikEngine(), makeNote(), [], "What does RuBisCO do?");
    expect(answer).toBe("RuBisCO fixes CO2 onto RuBP.");
  });

  it("a chat answer with no text is an error, never an empty reply", async () => {
    reasoningGateway({
      "publik-balanced": () => ({ reasoning: 50_000, content: "never" }),
      "publik-fast": () => ({ reasoning: 50_000, content: "never" }),
    });
    await expect(chatAnswer(publikEngine(), makeNote(), [], "What does RuBisCO do?")).rejects.toMatchObject({ kind: "truncated" });
  });

  it("a quiz whose model thinks past the gateway default still parses", async () => {
    const quiz = JSON.stringify({
      questions: [{ type: "mcq", topic: "Light", difficulty: "basic", question: "Main energy source?", options: ["Light", "Sound"], correctIndex: 0, explanation: "Light powers it." }],
    });
    const sent = reasoningGateway({
      "publik-balanced": () => ({ reasoning: 9000, content: quiz }),
      "publik-fast": () => ({ reasoning: 31, content: quiz }),
    });
    const qs = await generateQuiz(publikEngine(), makeNote());
    expect(qs).toHaveLength(1);
    expect(sent[0].max_tokens).toBeGreaterThanOrEqual(16000);
    expect(sent[0].reasoning_effort).toBe("low");
  });

  it("a quiz cut on both tiers says so in words, not as a JSON parse error", async () => {
    const quiz = JSON.stringify({ questions: [] });
    reasoningGateway({
      "publik-balanced": () => ({ reasoning: 50_000, content: quiz }),
      "publik-fast": () => ({ reasoning: 50_000, content: quiz }),
    });
    const err = await generateQuiz(publikEngine(), makeNote()).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.kind).toBe("truncated");
    expect(err.message).toMatch(/length limit before it finished the quiz/);
  });

  it("reasoning_effort goes to publik only, never to the user's own OpenAI key", async () => {
    const sent = reasoningGateway({
      "gpt-4o": () => ({ reasoning: 0, content: "# Notes\n\n- ok" }),
      "publik-balanced": () => ({ reasoning: 0, content: "# Notes\n\n- ok" }),
    });
    await generateNoteBody(resilient(createEngine({ mode: "cloud", provider: "openai", apiKey: "sk-test" })), "x", "English");
    await generateNoteBody(publikEngine(), "x", "English");
    expect(sent[0].model).toBe("gpt-4o");
    expect(sent[0].reasoning_effort).toBeUndefined();
    expect(sent[1].reasoning_effort).toBe("low");
    expect(sent[1].messages[0].content).toBe(noteSystem("English"));
  });
});
