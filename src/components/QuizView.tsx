/* Quiz tab: generate a quiz from the note's content, answer questions one by
   one, and track mastery by topic. Self-contained — owns its own load/
   generate/answer/reset flow against the repo + engine from useApp(). */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ListChecks,
  Loader2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useApp } from "../lib/app";
import { contentFor, generateQuiz } from "../lib/generation";
import { EngineError } from "../lib/engine/types";
import { masteryByTopic, masteryColor, type TopicMastery } from "../lib/study/mastery";
import { now, uuid } from "../lib/ids";
import type { Note, QuizAttempt, QuizQuestion } from "../lib/types";

type Difficulty = QuizQuestion["difficulty"];

interface AnsweredState {
  chosen: number | string;
  correct: boolean;
}

export default function QuizView({ note }: { note: Note }) {
  const { repo, engine } = useApp();

  const [loaded, setLoaded] = useState(false);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const [answered, setAnswered] = useState<Record<string, AnsweredState>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [difficulty, setDifficulty] = useState<Difficulty>("intermediate");
  const [count, setCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    (async () => {
      if (!repo) return;
      const [qs, as] = await Promise.all([
        repo.questionsFor(note.id),
        repo.attemptsFor(note.id),
      ]);
      if (!alive) return;
      setQuestions(qs);
      setAttempts(as);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [repo, note.id]);

  const content = contentFor(note);
  const mastery = useMemo(() => masteryByTopic(questions, attempts), [questions, attempts]);
  const scoreCorrect = useMemo(
    () => Object.values(answered).filter((a) => a.correct).length,
    [answered],
  );

  async function handleGenerate() {
    if (!engine) {
      setError("Set up your engine in Settings first.");
      return;
    }
    if (!repo) return;
    setError(null);
    setGenerating(true);
    try {
      const result = await generateQuiz(engine, note, { count, difficulty });
      await repo.putQuestions(result);
      setQuestions(result);
      setAnswered({});
      setDrafts({});
    } catch (e) {
      setError(
        e instanceof EngineError
          ? e.message
          : "Could not generate the quiz. Please try again.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleAnswer(q: QuizQuestion, chosenIndex: number | null, chosenText?: string) {
    if (!repo || answered[q.id]) return;
    const correct =
      q.type === "fill_blank"
        ? (chosenText ?? "").trim().toLowerCase() === (q.options[0] ?? "").trim().toLowerCase()
        : chosenIndex === q.correctIndex;

    const attempt: QuizAttempt = {
      id: uuid(),
      noteId: note.id,
      questionId: q.id,
      topic: q.topic,
      correct,
      at: now(),
    };
    await repo.putAttempt(attempt);
    setAttempts((prev) => [...prev, attempt]);
    setAnswered((prev) => ({
      ...prev,
      [q.id]: { chosen: chosenIndex ?? chosenText ?? "", correct },
    }));
  }

  async function handleReset() {
    if (!repo) return;
    await repo.resetQuiz(note.id);
    setAttempts([]);
    setAnswered({});
    setDrafts({});
  }

  if (!content.trim()) {
    return (
      <div className="px-16 py-12">
        <Header />
        <div className="mx-auto mt-10 max-w-4xl rounded-card bg-callout-bg p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="size-5 text-callout-ink" />
            <span className="font-display font-bold">Document is empty!</span>
          </div>
          <p className="mt-3 pl-8 text-ink-dim">
            Add some notes to your document to generate a quiz. Quizzes are
            created based on the notes in your document.
          </p>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-faint">
        <Loader2 className="size-6 animate-spin" />
        <p className="text-sm font-semibold">Loading quiz…</p>
      </div>
    );
  }

  return (
    <div className="px-16 py-12">
      <Header />

      {questions.length === 0 ? (
        <div className="mx-auto mt-10 max-w-xl rounded-card border border-edge bg-card p-6 shadow-soft">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-xs font-semibold text-ink-faint">Difficulty</label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as Difficulty)}
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
                onChange={(e) => setCount(Number(e.target.value))}
                className="mt-1 block rounded-xl border border-edge bg-panel px-3 py-2 text-sm outline-none"
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={15}>15</option>
              </select>
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="ml-auto flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {generating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Building your quiz…
                </>
              ) : (
                <>
                  <ListChecks className="size-4" />
                  Generate quiz
                </>
              )}
            </button>
          </div>
          {error && (
            <div className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger-ink">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto mt-10 grid max-w-6xl gap-8 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-ink">Questions</h2>
              <span className="rounded-full bg-accent-softer px-3 py-1 text-xs font-bold text-accent">
                {scoreCorrect} / {questions.length} correct
              </span>
            </div>
            {questions.map((q, i) => (
              <QuestionCard
                key={q.id}
                index={i}
                q={q}
                answer={answered[q.id]}
                draft={drafts[q.id] ?? ""}
                onDraftChange={(v) => setDrafts((prev) => ({ ...prev, [q.id]: v }))}
                onAnswer={(chosenIndex, chosenText) => handleAnswer(q, chosenIndex, chosenText)}
              />
            ))}
          </div>

          <MasteryPanel mastery={mastery} onReset={handleReset} />
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="text-center">
      <h1 className="font-display text-4xl font-bold">Welcome to Quizzes</h1>
      <p className="mt-2 text-ink-faint">Test yourself and track mastery by topic.</p>
    </div>
  );
}

function QuestionCard({
  q,
  index,
  answer,
  draft,
  onDraftChange,
  onAnswer,
}: {
  q: QuizQuestion;
  index: number;
  answer?: AnsweredState;
  draft: string;
  onDraftChange: (v: string) => void;
  onAnswer: (chosenIndex: number | null, chosenText?: string) => void;
}) {
  const isAnswered = !!answer;

  return (
    <div className="rounded-card border border-edge bg-card p-6 shadow-soft">
      <div className="flex items-start justify-between gap-4">
        <p className="font-display text-base font-semibold text-ink">
          <span className="mr-2 text-ink-faint">{index + 1}.</span>
          {q.question}
        </p>
        {isAnswered &&
          (answer.correct ? (
            <CheckCircle2 className="size-5 shrink-0 text-green-600" />
          ) : (
            <XCircle className="size-5 shrink-0 text-danger-ink" />
          ))}
      </div>

      {q.type === "fill_blank" ? (
        <div className="mt-4 flex items-center gap-2">
          <input
            value={isAnswered ? String(answer.chosen) : draft}
            onChange={(e) => onDraftChange(e.target.value)}
            disabled={isAnswered}
            placeholder="Type your answer…"
            className="w-full rounded-xl border border-edge bg-panel px-3 py-2 text-sm outline-none placeholder:text-ink-faint disabled:opacity-70"
          />
          <button
            onClick={() => onAnswer(null, draft)}
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
                onClick={() => onAnswer(i)}
                className={`rounded-xl border px-4 py-2.5 text-left text-sm font-semibold ${cls}`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      )}

      {isAnswered && q.explanation && (
        <div className="mt-4 rounded-xl bg-accent-softer p-4 text-sm text-ink-dim">
          <span className="font-display font-bold text-ink">Explanation: </span>
          {q.explanation}
        </div>
      )}
    </div>
  );
}

function MasteryPanel({
  mastery,
  onReset,
}: {
  mastery: TopicMastery[];
  onReset: () => void;
}) {
  return (
    <aside className="h-fit rounded-card border border-edge bg-card p-5 shadow-soft lg:sticky lg:top-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-sm font-bold text-ink">Mastery by topic</h2>
        <button
          onClick={onReset}
          className="flex shrink-0 items-center gap-1 text-xs font-semibold text-ink-faint hover:text-danger-ink"
        >
          <RotateCcw className="size-3.5" />
          Reset quiz
        </button>
      </div>
      {mastery.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">No topics yet.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {mastery.map((m) => {
            const color = masteryColor(m.pct);
            const barClass =
              color === "green"
                ? "bg-green-500"
                : color === "amber"
                  ? "bg-amber-500"
                  : "bg-red-500";
            return (
              <div key={m.topic}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate font-semibold text-ink">{m.topic}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {m.correct}/{m.total}
                  </span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-panel">
                  <div
                    className={`h-full rounded-full ${barClass}`}
                    style={{ width: `${m.pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
