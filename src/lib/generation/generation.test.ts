import { describe, expect, it } from "vitest";
import type {
  Engine,
  EngineCapabilities,
  CompletionOptions,
  StructuredOptions,
  TokenHandler,
  TranscriptResult,
} from "../engine/types";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Note } from "../types";
import { uuid, now } from "../ids";
import {
  generateFlashcards,
  generateQuiz,
  generateNoteBody,
  generateSampleQuiz,
  generateTitle,
  chatAnswer,
} from "./index";
import { createNoteFromSources } from "./pipeline";
import { quizSchema, sampleQuizSchema } from "../prompts";

/* A deterministic in-memory engine: no network. Returns canned output keyed by
   the structured schemaName, and a fixed markdown doc for completions. */
class FakeEngine implements Engine {
  readonly mode = "cloud" as const;
  calls: string[] = [];
  completeCalls = 0;
  capabilities(): EngineCapabilities {
    return { chat: true, transcription: true, tts: true, embeddings: true };
  }
  async complete(opts: CompletionOptions, onToken?: TokenHandler): Promise<string> {
    this.completeCalls++;
    // A tiny title vs note heuristic: short maxTokens => title.
    if ((opts.maxTokens ?? 999) <= 40) {
      onToken?.("Photosynthesis Basics");
      return "Photosynthesis Basics";
    }
    const md = "# Overview\n\nPlants make food.\n\n## Key Takeaways\n\n- Light matters";
    for (const ch of md) onToken?.(ch);
    return md;
  }
  async structured<T>(opts: StructuredOptions<T>): Promise<T> {
    this.calls.push(opts.schemaName);
    const byName: Record<string, unknown> = {
      topics: { topics: ["Light", "Water"] },
      flashcards: {
        cards: [
          { front: "What drives photosynthesis?", back: "Light", topic: "Light" },
          { front: "What is a reactant?", back: "Water", topic: "Water" },
        ],
      },
      quiz: {
        questions: [
          {
            type: "mcq",
            topic: "Light",
            difficulty: "basic",
            question: "Main energy source?",
            options: ["Light", "Sound", "Heat", "Cold"],
            correctIndex: 0,
            explanation: "Light powers it.",
          },
        ],
      },
      podcast: {
        lines: [
          { speaker: "host", text: "Hi!", spoken: "Hi!" },
          { speaker: "guest", text: "Tell me about H2O", spoken: "Tell me about water" },
        ],
      },
    };
    return byName[opts.schemaName] as T;
  }
  async transcribe(): Promise<TranscriptResult> {
    return { text: "spoken lecture transcript", segments: [] };
  }
  async tts(): Promise<Blob> {
    return new Blob(["audio"], { type: "audio/mpeg" });
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
  async validate(): Promise<void> {}
}

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: uuid(),
    title: "T",
    sourceKind: "text",
    sourceText: "Plants convert light and water into energy.",
    blocks: [],
    createdAt: now(),
    updatedAt: now(),
    lastOpenedAt: now(),
    ...over,
  };
}

describe("generation tasks", () => {
  it("generateNoteBody parses streamed markdown into blocks", async () => {
    const engine = new FakeEngine();
    let streamed = "";
    const blocks = await generateNoteBody(engine, "src", "English", (d) => (streamed += d));
    expect(streamed.length).toBeGreaterThan(0);
    expect(blocks[0].type).toBe("heading1");
    expect(blocks.some((b) => b.type === "bullet")).toBe(true);
  });

  it("map-reduces a large document with multiple model calls", async () => {
    const engine = new FakeEngine();
    // ~62k chars ≈ 15k tokens, well over the 6k-token chunk budget.
    const big = "Photosynthesis is the core process of plants. ".repeat(1400);
    const blocks = await generateNoteBody(engine, big, "English");
    expect(engine.completeCalls).toBeGreaterThan(1); // section maps (+ reduce)
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("generateTitle trims to a clean title", async () => {
    const engine = new FakeEngine();
    expect(await generateTitle(engine, "text")).toBe("Photosynthesis Basics");
  });

  it("generateFlashcards runs two phases and seeds FSRS state", async () => {
    const engine = new FakeEngine();
    const cards = await generateFlashcards(engine, makeNote());
    expect(engine.calls).toEqual(["topics", "flashcards"]);
    expect(cards).toHaveLength(2);
    expect(cards[0].state).toBe("new");
    expect(cards[0].noteId).toBeTruthy();
  });

  it("generateQuiz attaches ids and noteId", async () => {
    const engine = new FakeEngine();
    const note = makeNote();
    const qs = await generateQuiz(engine, note, { count: 1 });
    expect(qs[0].noteId).toBe(note.id);
    expect(qs[0].correctIndex).toBe(0);
  });

  it("generateQuiz asks for short answers with their model answer by default", async () => {
    const engine = new FakeEngine();
    let sent: StructuredOptions<unknown> | null = null;
    const original = engine.structured.bind(engine);
    engine.structured = async <T,>(opts: StructuredOptions<T>) => {
      sent = opts;
      return original(opts);
    };
    await generateQuiz(engine, makeNote());
    expect(sent!.system).toContain("short_answer");
    expect(sent!.system).toMatch(/model answer/);
  });
});

describe("sample quiz across lessons", () => {
  const sampleQuestion = (lesson: number, type = "mcq") => ({
    type,
    topic: "T",
    difficulty: "basic",
    question: `From lesson ${lesson}?`,
    options: type === "short_answer" ? ["A full model answer."] : ["a", "b", "c", "d"],
    correctIndex: 0,
    explanation: "Because.",
    lesson,
  });

  function capture(questions: unknown[]) {
    const engine = new FakeEngine();
    const sent: StructuredOptions<unknown>[] = [];
    engine.structured = async <T,>(opts: StructuredOptions<T>) => {
      sent.push(opts);
      return { questions } as T;
    };
    return { engine, sent };
  }

  it("numbers each lesson in one request and traces questions back to their note", async () => {
    const a = makeNote({ title: "Cells", sourceText: "Cells have membranes." });
    const b = makeNote({ title: "Genes", sourceText: "Genes code for proteins." });
    const { engine, sent } = capture([sampleQuestion(2), sampleQuestion(1, "short_answer")]);
    const qs = await generateSampleQuiz(engine, [a, b], { count: 2 });

    expect(sent).toHaveLength(1);
    expect(sent[0].schemaName).toBe("sample_quiz");
    expect(sent[0].messages[0].content).toContain("--- LESSON 1: Cells ---\nCells have membranes.");
    expect(sent[0].messages[0].content).toContain("--- LESSON 2: Genes ---\nGenes code for proteins.");
    expect(qs.map((q) => q.noteId)).toEqual([b.id, a.id]);
    expect(qs[1].options[0]).toBe("A full model answer.");
    expect(qs[0]).not.toHaveProperty("lesson");
  });

  it("falls back to the first lesson when the model names one that doesn't exist", async () => {
    const a = makeNote();
    const { engine } = capture([sampleQuestion(7)]);
    const [q] = await generateSampleQuiz(engine, [a]);
    expect(q.noteId).toBe(a.id);
  });

  it("skips empty lessons and refuses when none have content", async () => {
    const empty = makeNote({ title: "Blank", sourceText: "" });
    const full = makeNote({ title: "Full" });
    const { engine, sent } = capture([sampleQuestion(1)]);
    const [q] = await generateSampleQuiz(engine, [empty, full]);
    expect(sent[0].messages[0].content).not.toContain("Blank");
    expect(q.noteId).toBe(full.id);
    await expect(generateSampleQuiz(engine, [empty])).rejects.toThrow(/no notes/);
  });

  it("requires a lesson number on every question without touching the base quiz schema", () => {
    const item = sampleQuizSchema.properties.questions.items;
    expect(item.required).toContain("lesson");
    expect(item.properties.lesson).toEqual({ type: "integer" });
    expect(quizSchema.properties.questions.items.required).not.toContain("lesson");
    expect(item.properties.type.enum).toContain("short_answer");
  });
});

describe("createNoteFromSources pipeline", () => {
  it("creates a note with blocks + title from a text source", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [{ kind: "text", text: "some lecture text" }],
    });
    const note = await repo.getNote(id);
    expect(note).toBeTruthy();
    expect(note!.title).toBe("Photosynthesis Basics");
    expect(note!.blocks.length).toBeGreaterThan(0);
  });

  it("transcribes an audio source before writing notes", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [{ kind: "audio", file: new Blob(["x"]), filename: "lecture.mp3" }],
    });
    const note = await repo.getNote(id);
    expect(note!.sourceText).toContain("transcript");
  });

  it("records per-file status and still succeeds when one source fails", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const jobs: string[][] = [];
    // A "url" source fails in Node (no DOMParser); the text source succeeds.
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [
        { kind: "text", text: "good source" },
        { kind: "url", url: "https://example.com" },
      ],
      onProgress: (j) => jobs.push((j.files ?? []).map((f) => f.status)),
    });
    const note = await repo.getNote(id);
    expect(note).toBeTruthy();
    const finalStatuses = jobs.at(-1)!;
    expect(finalStatuses).toContain("done");
    expect(finalStatuses).toContain("error");
  });

  it("remembers every uploaded file name, skipping ones that failed", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [
        { kind: "audio", file: new Blob(["x"]), filename: "week1.mp3" },
        { kind: "url", url: "https://example.com" },
        { kind: "audio", file: new Blob(["y"]), filename: "week2.m4a" },
      ],
    });
    const note = await repo.getNote(id);
    expect(note!.sourceFiles).toEqual(["week1.mp3", "week2.m4a"]);
  });

  it("leaves sourceFiles unset for notes with no uploaded files", async () => {
    const repo = new Repo(memoryStore());
    const id = await createNoteFromSources({
      repo,
      engine: new FakeEngine(),
      inputs: [{ kind: "text", text: "pasted text" }],
    });
    expect((await repo.getNote(id))!.sourceFiles).toBeUndefined();
  });

  it("blank source produces an empty untitled note", async () => {
    const repo = new Repo(memoryStore());
    const engine = new FakeEngine();
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [{ kind: "blank" }],
    });
    const note = await repo.getNote(id);
    expect(note!.title).toBe("Untitled Document");
    expect(note!.blocks).toHaveLength(0);
  });
});

describe("chat about highlighted text", () => {
  it("frames the quote with the question, and keeps it on earlier turns", async () => {
    const engine = new FakeEngine();
    let sent: CompletionOptions | null = null;
    engine.complete = async (opts) => {
      sent = opts;
      return "ok";
    };
    const note = makeNote();
    const earlier = [
      { id: "u1", noteId: note.id, role: "user" as const, content: "Explain this", quote: "Chlorophyll is green.", at: 1 },
      { id: "a1", noteId: note.id, role: "assistant" as const, content: "It reflects green light.", at: 2 },
    ];
    await chatAnswer(engine, note, earlier, "Give me an example", "Plants make sugar.");
    const msgs = sent!.messages;
    expect(msgs[0].content).toContain("--- HIGHLIGHTED PASSAGE ---\nChlorophyll is green.\n");
    expect(msgs[0].content).toContain("My question: Explain this");
    expect(msgs[1].content).toBe("It reflects green light.");
    expect(msgs[2].content).toContain("Plants make sugar.");
    expect(msgs[2].content).toMatch(/My question: Give me an example$/);
    expect(sent!.tier).toBe("strong");
  });

  it("trims a very long selection and leaves plain questions alone", async () => {
    const engine = new FakeEngine();
    const seen: string[] = [];
    engine.complete = async (opts) => {
      seen.push(opts.messages.at(-1)!.content);
      return "ok";
    };
    await chatAnswer(engine, makeNote(), [], "Why?", "x".repeat(10_000));
    await chatAnswer(engine, makeNote(), [], "Plain question");
    expect(seen[0]).toContain(`${"x".repeat(4000)}…`);
    expect(seen[0]).not.toContain("x".repeat(4001));
    expect(seen[1]).toBe("Plain question");
  });
});
