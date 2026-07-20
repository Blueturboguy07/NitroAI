/* Versioned prompt templates + JSON schemas for all generation tasks.
   Structured tasks (flashcards, quiz, podcast) use strict JSON-schema output;
   free-form tasks (notes, chat, title) stream markdown/text. No source citations
   are emitted in generated content by design. */

export const PROMPTS_VERSION = 1;

/* ---- Notes -------------------------------------------------------------- */

export function noteSystem(language: string): string {
  return [
    "You are an expert study-note writer. Turn the user's source material into",
    "clear, well-structured study notes in GitHub-flavored Markdown.",
    "",
    "Requirements:",
    "- Open with a one-paragraph overview of what the material covers.",
    "- Use multi-level headings (#, ##, ###) to organize by concept, following the",
    "  source's natural order.",
    "- Use bullet and numbered lists; **bold** key terms and definitions.",
    "- Use Markdown tables for comparisons or structured data.",
    "- Use blockquote callouts `> [!note]` for important definitions or warnings.",
    "- Render math with KaTeX: inline `$x^2$`, display `$$...$$`. Preserve all",
    "  formulas, symbols, and code exactly.",
    "- Genuinely synthesize and explain — do NOT merely reorder the source.",
    "- End with a `## Key Takeaways` list.",
    "- Produce the COMPLETE notes. Never truncate or add a paywall.",
    `- Write in ${language}.`,
    "Output ONLY the raw Markdown notes — no preamble, and do NOT wrap the whole",
    "response in a ``` code fence.",
  ].join("\n");
}

export function noteUser(sourceText: string): string {
  return `Source material:\n\n${sourceText}`;
}

/* For large documents processed in chunks (map step): notes for ONE section. */
export function noteSectionSystem(
  language: string,
  part: number,
  total: number,
): string {
  return [
    `You are writing study notes for section ${part} of ${total} of a longer`,
    "document. Produce clear, well-structured Markdown notes for THIS section",
    "only. Use ## and ### headings, bullet lists, **bold** key terms, tables, and",
    "KaTeX math ($…$, $$…$$) where relevant. Genuinely explain — do not just",
    "restate. Do NOT add an overall introduction, overview, or conclusion; those",
    `are added once at the end. Write in ${language}. Output only the Markdown.`,
  ].join("\n");
}

/* Reduce step: merge per-section notes into one coherent document. */
export function noteReduceSystem(language: string): string {
  return [
    "You are given study notes assembled from consecutive sections of one",
    "document. Merge them into a single coherent set of notes: open with a short",
    "overview paragraph, keep ALL substantive content, remove duplicated headings",
    "or repeated points, keep a logical order, and close with a `## Key Takeaways`",
    `list. Do not truncate. Write in ${language}. Output only the Markdown.`,
  ].join("\n");
}

/* ---- Title -------------------------------------------------------------- */

export const titleSystem =
  "You write concise, specific document titles. Given study notes or source " +
  "text, reply with a single title of at most 8 words. No quotes, no trailing " +
  'punctuation, no filler like "Notes on" or "Summary of". Title only.';

export function titleUser(text: string): string {
  return `Material:\n\n${text.slice(0, 4000)}`;
}

/* ---- Flashcards (two-phase) --------------------------------------------- */

export const topicsSystem =
  "You identify the main study topics in source material. Return 4–8 concise " +
  "topic labels (2–4 words each) that together cover the material.";

export const topicsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: { type: "array", items: { type: "string" } },
  },
} as const;

export function flashcardsSystem(topics: string[]): string {
  return [
    "You create study flashcards from source material.",
    "Rules: one atomic concept per card; the front is a question or term, the",
    "back is a complete, self-contained answer. Prefer active recall over",
    "recognition. Tag each card with the single most relevant topic from this",
    `list: ${topics.join(", ")}.`,
    "Create thorough coverage — aim for 2–4 cards per topic.",
  ].join("\n");
}

export const flashcardsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["front", "back", "topic"],
        properties: {
          front: { type: "string" },
          back: { type: "string" },
          topic: { type: "string" },
        },
      },
    },
  },
} as const;

/* ---- Quiz --------------------------------------------------------------- */

export function quizSystem(opts: {
  count: number;
  difficulty: string;
  types: string[];
}): string {
  return [
    `Create a ${opts.count}-question quiz from the source material at`,
    `${opts.difficulty} difficulty. Use these question types: ${opts.types.join(", ")}.`,
    "For mcq: exactly 4 plausible options, one correct. For true_false: options",
    'are ["True","False"]. For fill_blank: options is a single-element array with',
    "the exact answer, and correctIndex is 0; write the question with a ___ blank.",
    "correctIndex is the 0-based index of the correct option. Every question needs",
    "a one-sentence explanation of why the answer is correct. Tag each with a topic.",
  ].join("\n");
}

export const quizSchema = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "topic",
          "difficulty",
          "question",
          "options",
          "correctIndex",
          "explanation",
        ],
        properties: {
          type: { type: "string", enum: ["mcq", "true_false", "fill_blank"] },
          topic: { type: "string" },
          difficulty: {
            type: "string",
            enum: ["basic", "intermediate", "exam"],
          },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctIndex: { type: "integer" },
          explanation: { type: "string" },
        },
      },
    },
  },
} as const;

/* ---- Chat --------------------------------------------------------------- */

export function chatSystem(noteTitle: string, sourceText: string): string {
  return [
    `You are a study assistant helping with the document "${noteTitle}".`,
    "Answer questions using the source material below. Be clear and concise, and",
    "use Markdown (headings, lists, **bold**) when helpful. For ANY math, symbols,",
    "or formulas, use KaTeX delimiters — inline `$E = mc^2$` and display `$$…$$` —",
    "never plain parentheses like ( F ). If the answer is not in the material, say",
    "so plainly rather than guessing. Do not add source citations.",
    "",
    "--- SOURCE MATERIAL ---",
    sourceText.slice(0, 100_000),
    "--- END SOURCE MATERIAL ---",
  ].join("\n");
}

/* ---- Podcast ------------------------------------------------------------ */

const PODCAST_TARGET: Record<string, number> = {
  short: 12,
  medium: 24,
  long: 40,
};

export function podcastSystem(length: "short" | "medium" | "long"): string {
  const lines = PODCAST_TARGET[length];
  return [
    "Write a two-host audio dialogue that teaches the source material, like a",
    "study podcast. host = the explainer, guest = the curious learner who asks",
    "good questions. Natural, engaging, accurate. Cover the key ideas.",
    `Aim for about ${lines} turns total.`,
    "For EACH line also provide a `spoken` field: the same content rewritten for",
    "text-to-speech — expand abbreviations, spell out symbols and equations in",
    "words, and phonetically respell hard/foreign/technical terms so a TTS voice",
    "pronounces them correctly (e.g. 'DLENA' -> 'duh-LAY-nuh'). The `text` field",
    "keeps the original readable version.",
  ].join("\n");
}

export const podcastSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "text", "spoken"],
        properties: {
          speaker: { type: "string", enum: ["host", "guest"] },
          text: { type: "string" },
          spoken: { type: "string" },
        },
      },
    },
  },
} as const;
