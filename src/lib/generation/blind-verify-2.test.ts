/* Defects from the blind verify of 89b3aa4, other than uploads (D1) and the
   Settings panel (D3):
   - D2: Local (Ollama) quiz and flashcards ignored a length stop; a cut JSON
     answer reached the screen as a raw SyntaxError.
   - "thinking" was said on Local and on models that do not reason.
   - A cut note could end with an unclosed "**".
   - A failed or cut title call saved "Untitled Document", and a cut title
     such as "# Partial notes" was saved as the title. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalEngine } from "../engine/local";
import { OpenAIEngine } from "../engine/openai";
import { createEngine } from "../engine";
import { resilient } from "../engine/resilient";
import { EngineError, truncatedError, type CompletionOptions, type Engine, type StructuredOptions, type TokenHandler } from "../engine/types";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import { uuid, now } from "../ids";
import type { Note } from "../types";
import { titleSystem } from "../prompts";
import { chatAnswer, closeOpenFences, emptyNoteError, generateFlashcards, generateNoteBody, generateQuiz, generateTitle, missingSectionNotice } from "./index";
import { createNoteFromSources } from "./pipeline";

afterEach(() => vi.unstubAllGlobals());

function ndjson(lines: unknown[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + "\n"));
        c.close();
      },
    }),
    { status: 200 },
  );
}
const sse = (frames: unknown[]): Response => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

/* The local engine exactly as app.tsx builds it. */
const localEngine = (): Engine => resilient(createEngine({ mode: "local" }));

function makeNote(over: Partial<Note> = {}): Note {
  return { id: uuid(), title: "Photosynthesis", sourceKind: "text", sourceText: "Plants convert light into sugar.", blocks: [], createdAt: now(), updatedAt: now(), lastOpenedAt: now(), ...over };
}

/* Ollama /api/chat, non-stream (structured): JSON cut at num_predict. */
function ollamaCutJson(thinking = "") {
  const fn = vi.fn(async () =>
    new Response(
      JSON.stringify({
        message: { role: "assistant", content: '{"questions":[{"type":"mcq","question":"What does RuBisCO fix?","options":["CO2","O', ...(thinking ? { thinking } : {}) },
        done: true,
        done_reason: "length",
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("D2 — Local (Ollama) quiz and flashcards at the length limit", () => {
  it("structured() with done_reason length is a truncated EngineError, not a SyntaxError", async () => {
    ollamaCutJson();
    const err = (await new LocalEngine().structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "quiz" }).catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.kind).toBe("truncated");
    expect(err).not.toBeInstanceOf(SyntaxError);
  });

  it("the quiz says in words that it stopped at the length limit (as on publik)", async () => {
    ollamaCutJson();
    const err = await generateQuiz(localEngine(), makeNote()).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("The AI reached its length limit before it finished the quiz, so nothing was saved. Try again.");
    expect(String(err.message)).not.toMatch(/SyntaxError|JSON/);
  });

  it("flashcards too", async () => {
    ollamaCutJson();
    const err = await generateFlashcards(localEngine(), makeNote()).catch((e) => e);
    expect(err.message).toMatch(/^The AI reached its length limit before it finished the flashcard/);
  });

  it("JSON that is broken for another reason is an EngineError in words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: { content: "{not json" }, done: true, done_reason: "stop" }), { status: 200 })));
    const err = (await new LocalEngine().structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "quiz" }).catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toBe("The local model returned an answer that is not complete JSON. Try again.");
  });
});

describe("'thinking' only when the model reported reasoning", () => {
  it("Ollama: an empty answer at the limit with no thinking says it stopped at its length limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjson([{ message: { content: "" } }, { done: true, done_reason: "length" }])));
    const err = await new LocalEngine().complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.kind).toBe("truncated");
    expect(err.message).toBe("The AI stopped at its length limit before it wrote an answer.");
    expect(err.detail.reasoning).toBeUndefined();
  });

  it("Ollama: a thinking model (message.thinking) does say thinking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjson([{ message: { content: "", thinking: "Let me see" } }, { done: true, done_reason: "length" }])));
    const err = await new LocalEngine().complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.message).toMatch(/whole length limit on thinking/);
    expect(err.detail.reasoning).toBe(true);
  });

  it("OpenAI dialect: a length stop with no reasoning reported does not say thinking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([{ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }])));
    const err = await new OpenAIEngine("sk-test").complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.message).toBe("The AI stopped at its length limit before it wrote an answer.");
  });

  it("OpenAI dialect: reasoning tokens in usage alone are enough to say thinking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
          { choices: [], usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4000 } } },
        ]),
      ),
    );
    const err = await new OpenAIEngine("sk-test").complete({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.message).toMatch(/whole length limit on thinking/);
  });

  it("the note and section messages follow the same rule", () => {
    const plain = truncatedError("");
    const thought = truncatedError("", undefined, true);
    expect(emptyNoteError(plain).message).toBe(
      "No note was saved: the AI stopped at its length limit before it wrote any text. Try again in a minute. A shorter source also helps.",
    );
    expect(emptyNoteError(thought).message).toMatch(/^No note was saved: the AI used its whole length limit on thinking and wrote no text\./);
    expect(emptyNoteError(null).message).toMatch(/^No note was saved: the AI wrote no text\./);
    expect(missingSectionNotice(2, 3, plain)).toContain("Section 2 of 3 is missing: the AI stopped at its length limit before it wrote notes for it.");
    expect(missingSectionNotice(2, 3, thought)).toContain("used its whole length limit on thinking");
    expect(missingSectionNotice(2, 3, null)).not.toMatch(/thinking|length limit/);
  });

  it("a Local note that comes back empty at the limit does not blame thinking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjson([{ message: { content: "" } }, { done: true, done_reason: "length" }])));
    const err = await generateNoteBody(localEngine(), "Plants convert light into sugar.").catch((e) => e);
    expect(err.message).toMatch(/^No note was saved: the AI stopped at its length limit/);
    expect(err.message).not.toMatch(/thinking/);
  });

  it("a Local chat answer that comes back empty at the limit does not blame thinking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjson([{ message: { content: "" } }, { done: true, done_reason: "length" }])));
    const err = await chatAnswer(localEngine(), makeNote(), [], "Why?").catch((e) => e);
    expect(err.message).toBe("The AI stopped at its length limit before it wrote an answer. Ask again, or ask a shorter question.");
  });
});

describe("a cut note closes an open **", () => {
  it("closes bold that the cut left open", () => {
    expect(closeOpenFences("## Calvin cycle\n\n- **RuBisCO fixes CO2 onto Ru")).toBe("## Calvin cycle\n\n- **RuBisCO fixes CO2 onto Ru**");
  });
  it("drops a ** that has nothing after it yet", () => {
    expect(closeOpenFences("- Key term: **")).toBe("- Key term:");
  });
  it("leaves closed bold, code spans, thematic breaks and earlier paragraphs alone", () => {
    expect(closeOpenFences("- **one** and **two**")).toBe("- **one** and **two**");
    expect(closeOpenFences("Use `a ** b` for powers")).toBe("Use `a ** b` for powers");
    expect(closeOpenFences("Text\n\n***")).toBe("Text\n\n***");
    expect(closeOpenFences("Old **open\n\nNew paragraph")).toBe("Old **open\n\nNew paragraph");
  });
  it("inside an open code block ** is code: the fence is closed, no ** added", () => {
    expect(closeOpenFences("```python\nx = 2 **")).toBe("```python\nx = 2 **\n```");
  });
  it("a cut note shows the closed bold before the notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjson([{ message: { content: "# Notes\n\n- **Light reac" } }, { done: true, done_reason: "length" }])));
    const blocks = await generateNoteBody(localEngine(), "Plants convert light into sugar.");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain("**Light reac**");
    expect(texts.some((t) => t.startsWith("These notes stop early"))).toBe(true);
  });
});

/* A cloud engine whose title call is cut (or fails) and whose note call works. */
class TitleFailEngine implements Engine {
  readonly mode = "cloud" as const;
  constructor(private readonly how: "cut" | "fail" | "markdown") {}
  capabilities() {
    return { chat: true, transcription: true, tts: true, embeddings: true };
  }
  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    if (opts.system === titleSystem) {
      if (this.how === "cut") throw truncatedError("# Partial notes");
      if (this.how === "fail") throw new EngineError("The AI service is busy.", "unknown");
      return "# **Title: The Calvin Cycle**";
    }
    const md = "# Carbon Fixation in Plants\n\n## Overview\n\n- RuBisCO fixes CO2.";
    onToken?.(md);
    return md;
  }
  async structured<T>(_o: StructuredOptions<T>): Promise<T> {
    return {} as T;
  }
  async transcribe() {
    return { text: "transcript", segments: [] };
  }
  async tts() {
    return new Blob();
  }
  async embed() {
    return [];
  }
  async validate() {}
}

describe("the note title when the title call fails or is cut", () => {
  it("generateTitle rejects a cut title instead of returning half of it", async () => {
    await expect(generateTitle(new TitleFailEngine("cut"), "text")).rejects.toMatchObject({ kind: "truncated" });
  });

  it("a whole title loses its markdown and its 'Title:' label", async () => {
    expect(await generateTitle(new TitleFailEngine("markdown"), "text")).toBe("The Calvin Cycle");
  });

  for (const how of ["cut", "fail"] as const) {
    it(`title call ${how}: an upload is named after its file`, async () => {
      const repo = new Repo(memoryStore());
      const file = new File(["Lecture 7: the Calvin cycle. RuBisCO fixes CO2."], "BIO 201 Lecture 7.txt");
      const id = await createNoteFromSources({ repo, engine: new TitleFailEngine(how), inputs: [{ kind: "text", file, filename: file.name }] });
      expect((await repo.getNote(id))!.title).toBe("BIO 201 Lecture 7");
    });
  }

  it("title call cut, source with no name: the note's first heading", async () => {
    const repo = new Repo(memoryStore());
    const id = await createNoteFromSources({ repo, engine: new TitleFailEngine("cut"), inputs: [{ kind: "text", text: "   " }, { kind: "audio", file: new Blob(["x"]) }] });
    const title = (await repo.getNote(id))!.title;
    expect(title).toBe("Carbon Fixation in Plants");
  });
});
