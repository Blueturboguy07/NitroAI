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
  generateTitle,
} from "./index";
import { createNoteFromSources } from "./pipeline";

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
