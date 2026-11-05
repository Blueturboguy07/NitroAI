/* Generation tasks. Each takes an Engine (cloud or local — identical interface)
   and returns domain objects. Persistence is the caller's job. */

import type { Engine, ChatMessage, CompletionOptions, StructuredOptions, TokenHandler } from "../engine/types";
import { EngineError } from "../engine/types";
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
import { capTokens, chunkByTokens, estimateTokens } from "./chunk";
import {
  chatSystem,
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

/* Output caps. publik's tiers are reasoning models, and the thinking counts
   against the SAME cap as the answer. Measured on NitroAI's own publik
   traffic (Sep 19 - Nov 2 2026, 196 note-sized calls on publik-balanced,
   served by xiaomi/mimo-v2.6-pro): the notes themselves were up to 5,169
   tokens at p90 and 8,048 at most; the thinking before them was 250 at the
   median, 2,440 at p90 and 8,198 at most (14 calls over 4,000). The old caps
   (4,000 per section, 6,000 merge, 8,000 single pass, 30 for a title, the
   gateway's 8,192 for flashcards / quiz / podcast / chat) left no room for
   that: on 2026-09-30 both sections of one paying user's note came back with
   4,000 tokens of thinking and no text, and the app saved a note made from
   nothing. A cap costs nothing unless it is used, and publik lowers it to fit
   a small balance (x-publik-output-capped). */
export const NOTE_MAX_TOKENS = 16000; // single pass and the merge step
export const SECTION_MAX_TOKENS = 12000; // one section of a long document
export const STUDY_MAX_TOKENS = 16000; // flashcards, quiz, podcast script (JSON)
export const CHAT_MAX_TOKENS = 12000;
export const TITLE_MAX_TOKENS = 1000;
/* Think briefly, then write. The gateway's default on publik-balanced is
   "medium"; a study note gains little from long thinking. Only the publik
   engine sends it (engine/openai.ts). */
export const REASONING_EFFORT = "low" as const;

const isTruncated = (e: unknown): e is EngineError => e instanceof EngineError && e.kind === "truncated";

/* What one call that may end at the cap gave back: the text, and the
   "truncated" error when the text is cut short (null when it is whole). */
export interface Fitted {
  text: string;
  cut: EngineError | null;
}

/* A completion that never ends empty without the caller knowing.
   - Text back: done. Text cut at the cap keeps its text plus `cut`.
   - NO text (the model thought until the cap, or answered nothing): one more
     try on the fast tier at the same cap. Its model barely thinks (NitroAI's
     publik-fast calls: 30 reasoning tokens at most), so the cap goes to the
     answer.
   - Still nothing: { text: "" } with the reason in `cut`. Callers turn that
     into an honest message; nothing empty is ever saved. */
export async function completeToFit(
  engine: Engine,
  opts: CompletionOptions,
  onToken?: TokenHandler,
): Promise<Fitted> {
  const once = async (o: CompletionOptions): Promise<Fitted> => {
    try {
      const text = await engine.complete(o, onToken);
      return { text, cut: null };
    } catch (e) {
      if (!isTruncated(e)) throw e;
      return { text: e.detail.partialText ?? "", cut: e };
    }
  };
  const first = await once(opts);
  if (first.text.trim()) return first;
  if (engine.mode !== "cloud" || opts.tier === "fast") return first;
  const second = await once({ ...opts, tier: "fast" });
  if (second.text.trim()) return second;
  // Both empty. Keep "it thought" when either try reported reasoning.
  let cut = second.cut ?? first.cut;
  if (cut && !cut.detail.reasoning && (first.cut?.detail.reasoning || second.cut?.detail.reasoning)) {
    cut = new EngineError(cut.message, cut.kind, { ...cut.detail, reasoning: true });
  }
  return { text: "", cut };
}

/* The JSON twin of completeToFit: a cut JSON answer cannot be used, so a
   cut on the strong tier gets one more try on the fast tier; a second cut is
   reported in words, never as a JSON parse error. */
export async function structuredToFit<T>(engine: Engine, opts: StructuredOptions<T>, what: string): Promise<T> {
  try {
    return await engine.structured<T>(opts);
  } catch (e) {
    if (!isTruncated(e)) throw e;
    if (engine.mode === "cloud" && opts.tier !== "fast") {
      try {
        return await engine.structured<T>({ ...opts, tier: "fast" });
      } catch (e2) {
        if (!isTruncated(e2)) throw e2;
        throw studyCutError(what, e2);
      }
    }
    throw studyCutError(what, e);
  }
}

function cappedSentence(e: EngineError | null): string {
  return e?.detail.cappedTo
    ? " publik API lowered the length limit to fit your balance; add a plan or pack in Settings to give it the full limit."
    : "";
}

function studyCutError(what: string, e: EngineError): EngineError {
  return new EngineError(
    `The AI reached its length limit before it finished the ${what}, so nothing was saved. Try again.${cappedSentence(e)}`,
    "truncated",
    e.detail,
  );
}

/* An open ``` or $$ block would swallow the notice appended after a cut,
   and a cut in the middle of **bold** leaves a bare "**" on the screen. */
export function closeOpenFences(md: string): string {
  const lines = md.split("\n");
  const fences = lines.filter((l) => /^\s*```/.test(l)).length;
  const math = lines.filter((l) => /^\s*\$\$\s*$/.test(l)).length;
  let out = md.replace(/\s+$/, "");
  // Inside an open code or math block "**" is literal text: leave it.
  if (fences % 2 === 0 && math % 2 === 0) out = closeOpenBold(out);
  if (fences % 2 === 1) out += "\n```";
  if (math % 2 === 1) out += "\n$$";
  return out;
}

/* Bold cannot cross a blank line, so only the last paragraph can hold the
   "**" that the cut left open. Code spans and thematic breaks ("***") do not
   count. An odd count gets a closing "**"; a "**" with nothing after it yet
   is dropped instead. */
function closeOpenBold(md: string): string {
  const lines = md.split("\n");
  let start = lines.length;
  while (start > 0 && lines[start - 1].trim() !== "" && !/^\s*(```|\$\$)/.test(lines[start - 1])) start--;
  const paragraph = lines
    .slice(start)
    .filter((l) => !/^\s{0,3}([*_-])(\s*\1){2,}\s*$/.test(l))
    .join("\n")
    .replace(/`[^`\n]*`/g, "");
  const marks = paragraph.match(/\*\*/g)?.length ?? 0;
  if (marks % 2 === 0) return md;
  if (md.endsWith("**")) return md.slice(0, -2).replace(/\s+$/, "");
  return `${md}**`;
}

/* Shown inside the note, where the text stops. */
export function cutNotice(e: EngineError | null): string {
  return `> [!warning] These notes stop early: the AI reached its length limit while writing this part. Create the note again, or split the source into smaller parts, to get the rest.${cappedSentence(e)}`;
}

/* Why a call gave no text. "Thinking" only when the model reported
   reasoning tokens; a cut with no reasoning just stopped at the length
   limit; no cut at all means the model sent back nothing. */
const NO_TEXT_WORDS = {
  notes: ["notes for it", "notes for it"],
  text: ["text", "any text"],
  answer: ["answer", "an answer"],
} as const;

function noTextReason(e: EngineError | null, what: keyof typeof NO_TEXT_WORDS): string {
  const [no, any] = NO_TEXT_WORDS[what];
  if (e?.detail.reasoning) return `the AI used its whole length limit on thinking and wrote no ${no}`;
  if (e) return `the AI stopped at its length limit before it wrote ${any}`;
  return `the AI wrote no ${no}`;
}

export function missingSectionNotice(part: number, total: number, e: EngineError | null): string {
  return `> [!warning] Section ${part} of ${total} is missing: ${noTextReason(e, "notes")}. Create the note again to fill it in.${cappedSentence(e)}`;
}

/* Every section came back empty (or the one pass did): nothing is saved. */
export function emptyNoteError(e: EngineError | null): EngineError {
  return new EngineError(
    `No note was saved: ${noTextReason(e, "text")}. Try again in a minute. A shorter source also helps.${cappedSentence(e)}`,
    "truncated",
    e?.detail ?? { partialText: "" },
  );
}

function withNotice(fitted: Fitted): string {
  const md = stripFence(fitted.text).trim();
  return fitted.cut ? `${closeOpenFences(md)}\n\n${cutNotice(fitted.cut)}` : md;
}

/* Study tools are generated from the *notes* (like Turbo), which are far smaller
   than a raw transcript; fall back to raw source only for a note with no body. */
export function studyContent(note: Note): string {
  const body = plainText(note.blocks);
  const base = body.trim() ? body : note.sourceText;
  return capTokens(base, STUDY_TOKENS);
}

/* The text used to ground generation: prefer the raw source; fall back to the
   note body (e.g. a blank note the user wrote by hand). */
export function contentFor(note: Note): string {
  return note.sourceText?.trim() ? note.sourceText : plainText(note.blocks);
}

/* The model's title line without markdown or a "Title:" label: "# Partial
   notes" → "Partial notes", "**Calvin Cycle**" → "Calvin Cycle". "" when
   nothing is left (generateTitle then fails and the pipeline uses the file
   name or the first heading). */
function cleanTitle(raw: string): string {
  const first = raw.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  const line = first
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*|__/g, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/["\u201c\u201d]/g, "")
    .trim();
  const words = line.split(/\s+/).slice(0, 8).join(" ");
  return words.replace(/[.,:;]+$/, "").trim();
}

/* ---- Notes -------------------------------------------------------------- */

export async function generateNoteBody(
  engine: Engine,
  sourceText: string,
  language = "English",
  onToken?: TokenHandler,
): Promise<Block[]> {
  const chunks = chunkByTokens(sourceText, NOTE_CHUNK_TOKENS, 150);

  // Small document: one streaming pass.
  if (chunks.length <= 1) {
    const fitted = await completeToFit(
      engine,
      {
        system: noteSystem(language),
        messages: [{ role: "user", content: noteUser(sourceText) }],
        tier: "strong",
        temperature: 0.4,
        maxTokens: NOTE_MAX_TOKENS,
        reasoningEffort: REASONING_EFFORT,
      },
      onToken,
    );
    if (!fitted.text.trim()) throw emptyNoteError(fitted.cut);
    return markdownToBlocks(withNotice(fitted));
  }

  // Large document: MAP — notes per section (sequential to respect TPM limits).
  // A section that comes back with no text is never passed on as "": it
  // becomes a visible "missing" notice, and the merge step is skipped.
  const parts: string[] = [];
  let written = 0;
  let whole = true;
  let lastCut: EngineError | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const fitted = await completeToFit(engine, {
      system: noteSectionSystem(language, i + 1, chunks.length),
      messages: [{ role: "user", content: noteUser(chunks[i]) }],
      tier: "strong",
      temperature: 0.4,
      maxTokens: SECTION_MAX_TOKENS,
      reasoningEffort: REASONING_EFFORT,
    });
    if (fitted.cut) {
      whole = false;
      lastCut = fitted.cut;
    }
    if (fitted.text.trim()) {
      written++;
      parts.push(withNotice(fitted));
      onToken?.(fitted.text);
    } else {
      whole = false;
      parts.push(missingSectionNotice(i + 1, chunks.length, fitted.cut));
    }
  }
  if (written === 0) throw emptyNoteError(lastCut);

  // REDUCE — merge into one coherent note only when every section came back
  // whole and the combined notes fit a request; otherwise keep the section
  // notes as they are (complete, just longer, notices included).
  let combined = parts.join("\n\n");
  if (whole && estimateTokens(combined) <= NOTE_CHUNK_TOKENS) {
    try {
      const merged = await engine.complete({
        system: noteReduceSystem(language),
        messages: [{ role: "user", content: combined }],
        tier: "strong",
        temperature: 0.3,
        maxTokens: NOTE_MAX_TOKENS,
        reasoningEffort: REASONING_EFFORT,
      });
      // A cut or empty merge would lose notes: keep the sections instead.
      if (merged.trim()) combined = stripFence(merged);
    } catch {
      /* keep the mapped section notes as-is (a cut merge lands here too) */
    }
  }
  return markdownToBlocks(combined);
}

export async function generateTitle(
  engine: Engine,
  text: string,
): Promise<string> {
  // 30 tokens used to be the cap: a fast-tier model that thought for 30
  // tokens returned no title (3 of 5 capped title calls in prod).
  const { text: title, cut } = await completeToFit(engine, {
    system: titleSystem,
    messages: [{ role: "user", content: titleUser(text) }],
    tier: "fast",
    temperature: 0.3,
    maxTokens: TITLE_MAX_TOKENS,
    reasoningEffort: REASONING_EFFORT,
  });
  if (!title.trim()) throw cut ?? new EngineError("The AI wrote no title.", "unknown");
  // A cut title is part of a title ("# Partial notes" was saved this way).
  if (cut) throw cut;
  const clean = cleanTitle(title);
  if (!clean) throw new EngineError("The AI wrote no title.", "unknown");
  return clean;
}

/* ---- Flashcards (two-phase: topics, then cards) ------------------------- */

export async function generateFlashcards(
  engine: Engine,
  note: Note,
): Promise<Flashcard[]> {
  const content = studyContent(note);
  const { topics } = await structuredToFit<{ topics: string[] }>(
    engine,
    {
      system: topicsSystem,
      messages: [{ role: "user", content }],
      schema: topicsSchema as unknown as Record<string, unknown>,
      schemaName: "topics",
      tier: "fast",
      maxTokens: STUDY_MAX_TOKENS,
      reasoningEffort: REASONING_EFFORT,
    },
    "flashcard topics",
  );
  const { cards } = await structuredToFit<{
    cards: { front: string; back: string; topic: string }[];
  }>(
    engine,
    {
      system: flashcardsSystem(topics.length ? topics : ["General"]),
      messages: [{ role: "user", content }],
      schema: flashcardsSchema as unknown as Record<string, unknown>,
      schemaName: "flashcards",
      tier: "strong",
      maxTokens: STUDY_MAX_TOKENS,
      reasoningEffort: REASONING_EFFORT,
    },
    "flashcards",
  );
  return cards.map((c) => ({
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
  const types = opts.types ?? ["mcq", "true_false", "fill_blank"];
  const content = studyContent(note);
  const { questions } = await structuredToFit<{
    questions: Omit<QuizQuestion, "id" | "noteId">[];
  }>(
    engine,
    {
      system: quizSystem({ count, difficulty, types }),
      messages: [{ role: "user", content }],
      schema: quizSchema as unknown as Record<string, unknown>,
      schemaName: "quiz",
      tier: "strong",
      maxTokens: STUDY_MAX_TOKENS,
      reasoningEffort: REASONING_EFFORT,
    },
    "quiz",
  );
  return questions.map((q) => ({ ...q, id: uuid(), noteId: note.id }));
}

/* ---- Chat --------------------------------------------------------------- */

export async function chatAnswer(
  engine: Engine,
  note: Note,
  history: ChatTurn[],
  question: string,
  onToken?: TokenHandler,
): Promise<string> {
  const messages: ChatMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: question },
  ];
  const { text, cut } = await completeToFit(
    engine,
    {
      system: chatSystem(note.title, studyContent(note)),
      messages,
      tier: "strong",
      temperature: 0.3,
      maxTokens: CHAT_MAX_TOKENS,
      reasoningEffort: REASONING_EFFORT,
    },
    onToken,
  );
  if (!text.trim()) {
    // Never save an empty answer as if it were one.
    const why = noTextReason(cut, "answer");
    throw new EngineError(
      `${why.charAt(0).toUpperCase()}${why.slice(1)}. Ask again, or ask a shorter question.${cappedSentence(cut)}`,
      "truncated",
      cut?.detail ?? { partialText: "" },
    );
  }
  if (!cut) return text;
  const tail = "\n\n_The answer stopped at the AI's length limit. Ask me to continue._";
  onToken?.(tail);
  return `${closeOpenFences(text)}${tail}`;
}

/* ---- Podcast ------------------------------------------------------------ */

export async function generatePodcastScript(
  engine: Engine,
  note: Note,
  length: "short" | "medium" | "long" = "short",
): Promise<Podcast> {
  const content = studyContent(note);
  const { lines } = await structuredToFit<{
    lines: { speaker: "host" | "guest"; text: string; spoken: string }[];
  }>(
    engine,
    {
      system: podcastSystem(length),
      messages: [{ role: "user", content }],
      schema: podcastSchema as unknown as Record<string, unknown>,
      schemaName: "podcast",
      tier: "strong",
      maxTokens: STUDY_MAX_TOKENS,
      reasoningEffort: REASONING_EFFORT,
    },
    "podcast script",
  );
  return { id: uuid(), noteId: note.id, length, script: lines, createdAt: now() };
}

export const DEFAULT_VOICES = { host: "alloy", guest: "nova" } as const;

/* Synthesize each line with its speaker's voice and concatenate to one clip.
   Throws EngineError (kind "unsupported"/"model_missing") if the active engine
   has no TTS — the UI surfaces that cleanly. */
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
  return new Blob(parts, { type: "audio/mpeg" });
}
