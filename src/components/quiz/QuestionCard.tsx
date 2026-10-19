/* Shared quiz pieces for the note Quiz tab and the sample quiz: one question
   card per type, the answer/draft/reveal state of a quiz session, and the
   settings form (difficulty, length, question types). */

import { useMemo, useState } from "react";
import { CheckCircle2, Eye, XCircle } from "lucide-react";
import { renderRichInline } from "../../lib/markdown";
import type { QuizQuestion, QuizType } from "../../lib/types";

export type Difficulty = QuizQuestion["difficulty"];

export interface AnsweredState {
  chosen: number | string;
  correct: boolean;
}

export const QUIZ_TYPE_LABELS: Record<QuizType, string> = {
  mcq: "Multiple choice",
  true_false: "True / false",
  fill_blank: "Fill in the blank",
  short_answer: "Short answer",
};

/* Fill-in-the-blank answers can arrive as Markdown/KaTeX ("**mitosis**",
   "$x^2 + 1$") while the learner types plain text, so both sides drop the
   formatting, spacing around operators and a closing full stop before they're
   compared. */
const normalize = (s: string) =>
  s
    .replace(/\$|`|\*\*|__/g, "")
    .trim()
    .replace(/^[*_](.+)[*_](?=\.?$)/, "$1")
    .replace(/\s*([+\-=^/*(),])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .toLowerCase();

/** Auto-grading for the objective types. Short answers are self-graded
 *  against the model answer, so they never come through here. */
export function isCorrect(q: QuizQuestion, chosen: number | string): boolean {
  return q.type === "fill_blank"
    ? normalize(String(chosen)) === normalize(q.options[0] ?? "")
    : chosen === q.correctIndex;
}

/* Answers, typed drafts and revealed short answers for one sitting of a quiz.
   `onAnswered` runs once per question, e.g. to record an attempt. */
export function useQuizSession(onAnswered?: (q: QuizQuestion, correct: boolean) => void) {
  const [answered, setAnswered] = useState<Record<string, AnsweredState>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const score = useMemo(() => Object.values(answered).filter((a) => a.correct).length, [answered]);

  function reset() {
    setAnswered({});
    setDrafts({});
    setRevealed({});
  }

  function cardProps(q: QuizQuestion) {
    return {
      q,
      answer: answered[q.id],
      draft: drafts[q.id] ?? "",
      revealed: !!revealed[q.id],
      onDraftChange: (v: string) => setDrafts((prev) => ({ ...prev, [q.id]: v })),
      onReveal: () => setRevealed((prev) => ({ ...prev, [q.id]: true })),
      onAnswer: (chosen: number | string, correct: boolean) => {
        if (answered[q.id]) return;
        setAnswered((prev) => ({ ...prev, [q.id]: { chosen, correct } }));
        onAnswered?.(q, correct);
      },
    };
  }

  return { answered, score, reset, cardProps };
}

/* Questions, options and explanations are model output: inline Markdown with
   $…$ LaTeX, rendered in place (and sanitized) rather than shown raw. */
function Rich({ text }: { text: string }) {
  const html = useMemo(() => renderRichInline(text), [text]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export function QuestionCard({
  q,
  index,
  lesson,
  answer,
  draft,
  revealed,
  onDraftChange,
  onReveal,
  onAnswer,
}: {
  q: QuizQuestion;
  index: number;
  /* Which lesson the question came from (sample quiz only). */
  lesson?: string;
  answer?: AnsweredState;
  draft: string;
  revealed: boolean;
  onDraftChange: (v: string) => void;
  onReveal: () => void;
  onAnswer: (chosen: number | string, correct: boolean) => void;
}) {
  const isAnswered = !!answer;
  const showExplanation = isAnswered || (q.type === "short_answer" && revealed);

  return (
    <div className="rounded-card border border-edge bg-card p-6 shadow-soft">
      {lesson && <p className="mb-1.5 truncate text-xs font-semibold text-ink-faint">{lesson}</p>}
      <div className="flex items-start justify-between gap-4">
        <p className="font-display text-base font-semibold text-ink">
          <span className="mr-2 text-ink-faint">{index + 1}.</span>
          <Rich text={q.question} />
        </p>
        {isAnswered &&
          (answer.correct ? (
            <CheckCircle2 className="size-5 shrink-0 text-green-600" />
          ) : (
            <XCircle className="size-5 shrink-0 text-danger-ink" />
          ))}
      </div>

      {q.type === "short_answer" ? (
        <div className="mt-4">
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            disabled={revealed}
            rows={3}
            placeholder="Write your answer, then reveal the model answer to check it…"
            className="w-full resize-y rounded-xl border border-edge bg-panel px-3 py-2 text-sm outline-none placeholder:text-ink-faint disabled:opacity-70"
          />
          {!revealed ? (
            <button
              onClick={onReveal}
              className="mt-2 flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover"
            >
              <Eye className="size-4" />
              Reveal answer
            </button>
          ) : (
            <>
              <div className="mt-3 whitespace-pre-line rounded-xl bg-success-soft p-4 text-sm text-ink">
                <span className="font-display font-bold">Model answer: </span>
                <Rich text={q.options[0] ?? ""} />
              </div>
              {!isAnswered && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-sm font-semibold text-ink-dim">Did your answer cover it?</span>
                  <button
                    onClick={() => onAnswer(draft, true)}
                    className="flex items-center gap-1.5 rounded-xl border border-edge bg-panel px-3 py-1.5 text-sm font-semibold hover:bg-card-hover"
                  >
                    <CheckCircle2 className="size-4 text-green-600" />
                    Got it
                  </button>
                  <button
                    onClick={() => onAnswer(draft, false)}
                    className="flex items-center gap-1.5 rounded-xl border border-edge bg-panel px-3 py-1.5 text-sm font-semibold hover:bg-card-hover"
                  >
                    <XCircle className="size-4 text-danger-ink" />
                    Not quite
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : q.type === "fill_blank" ? (
        <div className="mt-4 flex items-center gap-2">
          <input
            value={isAnswered ? String(answer.chosen) : draft}
            onChange={(e) => onDraftChange(e.target.value)}
            disabled={isAnswered}
            placeholder="Type your answer…"
            className="w-full rounded-xl border border-edge bg-panel px-3 py-2 text-sm outline-none placeholder:text-ink-faint disabled:opacity-70"
          />
          <button
            onClick={() => onAnswer(draft, isCorrect(q, draft))}
            disabled={isAnswered || !draft.trim()}
            className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Check
          </button>
        </div>
      ) : (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {q.options.map((opt, i) => {
            let cls = "border-edge bg-panel hover:bg-card-hover";
            if (isAnswered) {
              if (i === q.correctIndex) {
                cls = "border-transparent bg-success-soft text-ink";
              } else if (i === answer.chosen) {
                cls = "border-transparent bg-danger-soft text-danger-ink";
              } else {
                cls = "border-edge bg-panel text-ink-faint opacity-60";
              }
            }
            return (
              <button
                key={i}
                disabled={isAnswered}
                onClick={() => onAnswer(i, isCorrect(q, i))}
                className={`rounded-xl border px-4 py-2.5 text-left text-sm font-semibold ${cls}`}
              >
                <Rich text={opt} />
              </button>
            );
          })}
        </div>
      )}

      {showExplanation && q.explanation && (
        <div className="mt-4 rounded-xl bg-accent-softer p-4 text-sm text-ink-dim">
          <span className="font-display font-bold text-ink">Explanation: </span>
          <Rich text={q.explanation} />
        </div>
      )}
    </div>
  );
}

/* Difficulty, length and question types. At least one type stays ticked. */
export function QuizSettings({
  difficulty,
  onDifficulty,
  count,
  onCount,
  types,
  onTypes,
  counts = [5, 10, 15],
}: {
  difficulty: Difficulty;
  onDifficulty: (d: Difficulty) => void;
  count: number;
  onCount: (n: number) => void;
  types: QuizType[];
  onTypes: (t: QuizType[]) => void;
  counts?: number[];
}) {
  function toggleType(t: QuizType) {
    const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t];
    if (next.length) onTypes(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <div>
          <label className="text-xs font-semibold text-ink-faint">Difficulty</label>
          <select
            value={difficulty}
            onChange={(e) => onDifficulty(e.target.value as Difficulty)}
            className="mt-1 block rounded-xl border border-edge bg-panel px-3 py-2 text-sm outline-none"
          >
            <option value="basic">Basic</option>
            <option value="intermediate">Intermediate</option>
            <option value="exam">Exam</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-ink-faint">Questions</label>
          <select
            value={count}
            onChange={(e) => onCount(Number(e.target.value))}
            className="mt-1 block rounded-xl border border-edge bg-panel px-3 py-2 text-sm outline-none"
          >
            {counts.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset>
        <legend className="text-xs font-semibold text-ink-faint">Question types</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {(Object.keys(QUIZ_TYPE_LABELS) as QuizType[]).map((t) => {
            const on = types.includes(t);
            return (
              <label
                key={t}
                className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-semibold ${
                  on ? "border-accent bg-accent-softer text-ink" : "border-edge bg-panel text-ink-dim hover:bg-card-hover"
                }`}
              >
                <input type="checkbox" checked={on} onChange={() => toggleType(t)} className="accent-accent" />
                {QUIZ_TYPE_LABELS[t]}
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
