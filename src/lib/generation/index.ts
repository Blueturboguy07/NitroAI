/* Generation tasks. Each takes an Engine (cloud or local — identical interface)
   and returns domain objects. Persistence is the caller's job. */

import { EngineError, type Engine, type ChatMessage, type TokenHandler } from "../engine/types";
import type {
  Block,
  ChatTurn,
  Flashcard,
  Note,
  Podcast,
  QuizQuestion,
  QuizType,
} from "../types";
import { uuid, now } from "../ids";
import { markdownToBlocks, plainText, stripFence } from "../markdown";
import { newCardState } from "../study/fsrs";
import { capTokens, chunkByTokens, estimateTokens, lessonBudgets } from "./chunk";
import { concatWav } from "../audio/wav";
import {
  chatSystem,
  quotedQuestion,
  flashcardsSchema,
  flashcardsSystem,
  noteReduceSystem,
  noteSectionSystem,
  noteSystem,
  noteUser,
  podcastSchema,
  podcastSystem,
  quizSchema,
  quizSystem,
  sampleQuizSchema,
  sampleQuizSystem,
  sampleQuizUser,
  titleSystem,
  titleUser,
  topicsSchema,
  topicsSystem,
} from "../prompts";

/* Token budgets. Sized so a single request stays well under a low 30k-TPM
   free-tier key even after the model's own output. The engine layer adds 429
   backoff on top, so bigger docs just take longer — they never hard-fail. */
const NOTE_CHUNK_TOKENS = 6000; // input per map request
const STUDY_TOKENS = 8000; // grounding cap for cards/quiz/chat/podcast
/* Shared by every lesson in a sample quiz: a little more than one note gets,
   since it spans several, and still well under 30k TPM with the reply. */
const SAMPLE_TOKENS = 12000;

/* Study tools are generated from the *notes* (like Turbo), which are far smaller
   than a raw transcript; fall back to raw source only for a note with no body. */
function studyText(note: Note): string {
  const body = plainText(note.blocks);
  return body.trim() ? body : note.sourceText;
}

export function studyContent(note: Note): string {
  return capTokens(studyText(note), STUDY_TOKENS);
}

/* The text used to ground generation: prefer the raw source; fall back to the
   note body (e.g. a blank note the user wrote by hand). */
export function contentFor(note: Note): string {
  return note.sourceText?.trim() ? note.sourceText : plainText(note.blocks);
}

function cleanTitle(raw: string): string {
  const line = raw.replace(/["""]/g, "").split("\n")[0].trim();
  const words = line.split(/\s+/).slice(0, 8).join(" ");
  return words.replace(/[.,:;]+$/, "") || "Untitled Document";
}

/* ---- Answer checks ------------------------------------------------------ */

const UNREADABLE = "The model returned an unreadable answer — try again, or pick another model in Settings.";

/* An empty answer for a non-empty source would save a blank note that looks
   like success. */
function nonEmpty(blocks: Block[], sourceText: string): Block[] {
  if (blocks.length === 0 && sourceText.trim()) {
    throw new EngineError("The model returned empty notes — try again, or pick another model in Settings.", "unknown");
  }
  return blocks;
}

/* Structured answers are typed by schema, but a model can still drop a field
   (or a non-strict provider can return something else entirely). */
function listOf<T>(answer: unknown, key: string): T[] {
  const value = answer && typeof answer === "object" ? (answer as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(value)) throw new EngineError(UNREADABLE, "unknown");
  return value as T[];
}

/* ---- Notes -------------------------------------------------------------- */

export async function generateNoteBody(
  engine: Engine,
  sourceText: string,
  language = "English",
  onToken?: TokenHandler,
): Promise<Block[]> {
  const chunks = chunkByTokens(sourceText, NOTE_CHUNK_TOKENS, 150);

  // Small document: one streaming pass (unchanged behavior).
  if (chunks.length <= 1) {
    const md = await engine.complete(
      {
        system: noteSystem(language),
        messages: [{ role: "user", content: noteUser(sourceText) }],
        tier: "strong",
        temperature: 0.4,
        maxTokens: 8000,
      },
      onToken,
    );
    return nonEmpty(markdownToBlocks(stripFence(md)), sourceText);
  }

  // Large document: MAP — notes per section (sequential to respect TPM limits).
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const md = await engine.complete({
      system: noteSectionSystem(language, i + 1, chunks.length),
      messages: [{ role: "user", content: noteUser(chunks[i]) }],
      tier: "strong",
      temperature: 0.4,
      maxTokens: 4000,
    });
    parts.push(stripFence(md).trim());
    onToken?.(md);
  }

  // REDUCE — merge into one coherent note if the combined notes fit a request;
  // otherwise keep the concatenated section notes (still complete, just longer).
  let combined = parts.join("\n\n");
  if (estimateTokens(combined) <= NOTE_CHUNK_TOKENS) {
    try {
      combined = stripFence(
        await engine.complete({
          system: noteReduceSystem(language),
          messages: [{ role: "user", content: combined }],
          tier: "strong",
          temperature: 0.3,
          maxTokens: 6000,
        }),
      );
    } catch {
      /* keep the mapped section notes as-is */
    }
  }
  return nonEmpty(markdownToBlocks(combined), sourceText);
}

export async function generateTitle(
  engine: Engine,
  text: string,
): Promise<string> {
  const t = await engine.complete({
    system: titleSystem,
    messages: [{ role: "user", content: titleUser(text) }],
    tier: "fast",
    temperature: 0.3,
    maxTokens: 30,
  });
  return cleanTitle(t);
}

/* ---- Flashcards (two-phase: topics, then cards) ------------------------- */

export async function generateFlashcards(
  engine: Engine,
  note: Note,
): Promise<Flashcard[]> {
  const content = studyContent(note);
  const topics = listOf<string>(
    await engine.structured<{ topics: string[] }>({
      system: topicsSystem,
      messages: [{ role: "user", content }],
      schema: topicsSchema as unknown as Record<string, unknown>,
      schemaName: "topics",
      tier: "fast",
    }),
    "topics",
  );
  const cards = listOf<{ front: string; back: string; topic: string }>(
    await engine.structured<{
      cards: { front: string; back: string; topic: string }[];
    }>({
      system: flashcardsSystem(topics.length ? topics : ["General"]),
      messages: [{ role: "user", content }],
      schema: flashcardsSchema as unknown as Record<string, unknown>,
      schemaName: "flashcards",
      tier: "strong",
    }),
    "cards",
  );
  return cards.filter((c) => c && c.front && c.back).map((c) => ({
    id: uuid(),
    noteId: note.id,
    front: c.front,
    back: c.back,
    topic: c.topic || "General",
    ...newCardState(),
  }));
}

/* ---- Quiz --------------------------------------------------------------- */

export interface QuizOptions {
  count?: number;
  difficulty?: "basic" | "intermediate" | "exam";
  types?: QuizType[];
}

export async function generateQuiz(
  engine: Engine,
  note: Note,
  opts: QuizOptions = {},
): Promise<QuizQuestion[]> {
  const count = opts.count ?? 8;
  const difficulty = opts.difficulty ?? "intermediate";
  const types = opts.types ?? ALL_QUIZ_TYPES;
  const content = studyContent(note);
  const questions = listOf<Omit<QuizQuestion, "id" | "noteId">>(
    await engine.structured<{
      questions: Omit<QuizQuestion, "id" | "noteId">[];
    }>({
      system: quizSystem({ count, difficulty, types }),
      messages: [{ role: "user", content }],
      schema: quizSchema as unknown as Record<string, unknown>,
      schemaName: "quiz",
      tier: "strong",
    }),
    "questions",
  );
  return questions.map((q) => ({ ...q, id: uuid(), noteId: note.id }));
}

export const ALL_QUIZ_TYPES: QuizType[] = ["mcq", "true_false", "fill_blank", "short_answer"];

/* One quiz across several lessons (notes), in a single request. Each lesson
   gets a share of SAMPLE_TOKENS; every question comes back tagged with its
   lesson and is attributed to that note. */
export async function generateSampleQuiz(
  engine: Engine,
  notes: Note[],
  opts: QuizOptions = {},
): Promise<QuizQuestion[]> {
  const count = opts.count ?? 10;
  const difficulty = opts.difficulty ?? "intermediate";
  const types = opts.types ?? ALL_QUIZ_TYPES;
  const texts = notes.map(studyText);
  const budgets = lessonBudgets(texts.map(estimateTokens), SAMPLE_TOKENS);
  const lessons = notes
    .map((note, i) => ({ note, title: note.title, content: capTokens(texts[i], budgets[i] ?? 0).trim() }))
    .filter((l) => l.content);
  if (!lessons.length) {
    throw new EngineError("The selected lessons have no notes to quiz on yet.", "unknown");
  }
  const questions = listOf<Omit<QuizQuestion, "id" | "noteId"> & { lesson: number }>(
    await engine.structured<{
      questions: (Omit<QuizQuestion, "id" | "noteId"> & { lesson: number })[];
    }>({
      system: sampleQuizSystem({ count, difficulty, types, lessons: lessons.length }),
      messages: [{ role: "user", content: sampleQuizUser(lessons) }],
      schema: sampleQuizSchema as unknown as Record<string, unknown>,
      schemaName: "sample_quiz",
      tier: "strong",
    }),
    "questions",
  );
  return questions.map(({ lesson, ...q }) => ({
    ...q,
    id: uuid(),
    // A lesson number outside the list falls back to the first lesson.
    noteId: (lessons[lesson - 1] ?? lessons[0]).note.id,
  }));
}

/* ---- Chat --------------------------------------------------------------- */

export async function chatAnswer(
  engine: Engine,
  note: Note,
  history: ChatTurn[],
  question: string,
  quote?: string,
  onToken?: TokenHandler,
): Promise<string> {
  // Earlier turns keep their quoted passage so follow-ups ("simpler?") still
  // know what "this" refers to.
  const ask = (q: string, quoted?: string) => (quoted ? quotedQuestion(q, quoted) : q);
  const messages: ChatMessage[] = [
    ...history.map((h) => ({ role: h.role, content: ask(h.content, h.quote) })),
    { role: "user" as const, content: ask(question, quote) },
  ];
  return engine.complete(
    {
      system: chatSystem(note.title, studyContent(note)),
      messages,
      tier: "strong",
      temperature: 0.3,
    },
    onToken,
  );
}

/* ---- Podcast ------------------------------------------------------------ */

export async function generatePodcastScript(
  engine: Engine,
  note: Note,
  length: "short" | "medium" | "long" = "short",
): Promise<Podcast> {
  const content = studyContent(note);
  const lines = listOf<{ speaker: "host" | "guest"; text: string; spoken: string }>(
    await engine.structured<{
      lines: { speaker: "host" | "guest"; text: string; spoken: string }[];
    }>({
      system: podcastSystem(length),
      messages: [{ role: "user", content }],
      schema: podcastSchema as unknown as Record<string, unknown>,
      schemaName: "podcast",
      tier: "strong",
    }),
    "lines",
  );
  return { id: uuid(), noteId: note.id, length, script: lines, createdAt: now() };
}

export const DEFAULT_VOICES = { host: "alloy", guest: "nova" } as const;

/* Synthesize each line with its speaker's voice and concatenate to one clip.
   MP3 clips (OpenAI) are glued byte-for-byte; WAV clips (Gemini) are re-wrapped
   under one header. Throws EngineError (kind "unsupported"/"model_missing") if
   the active engine has no TTS — the UI surfaces that cleanly. */
export async function synthesizePodcastAudio(
  engine: Engine,
  podcast: Podcast,
  voices: { host: string; guest: string } = DEFAULT_VOICES,
  signal?: AbortSignal,
): Promise<Blob> {
  const parts: Blob[] = [];
  for (const line of podcast.script) {
    const blob = await engine.tts(line.spoken || line.text, {
      voice: voices[line.speaker],
      format: "mp3",
      signal,
    });
    parts.push(blob);
  }
  if (parts.length > 0 && parts.every((p) => p.type === "audio/wav")) return concatWav(parts);
  return new Blob(parts, { type: "audio/mpeg" });
}
