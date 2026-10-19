/* Quiz tab: generate a quiz from the note's content, answer questions one by
   one, and track mastery by topic. Self-contained — owns its own load/
   generate/answer/reset flow against the repo + engine from useApp(). */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ListChecks, Loader2, RotateCcw } from "lucide-react";
import { useApp } from "../lib/app";
import { ALL_QUIZ_TYPES, contentFor, generateQuiz } from "../lib/generation";
import { EngineError } from "../lib/engine/types";
import { describeError, type ShownError } from "../lib/publik";
import { ErrorNotice } from "./PublikNotice";
import { masteryByTopic, masteryColor, type TopicMastery } from "../lib/study/mastery";
import { now, uuid } from "../lib/ids";
import type { Note, QuizAttempt, QuizQuestion, QuizType } from "../lib/types";
import { QuestionCard, QuizSettings, useQuizSession, type Difficulty } from "./quiz/QuestionCard";

export default function QuizView({ note }: { note: Note }) {
  const { repo, engine } = useApp();

  const [loaded, setLoaded] = useState(false);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const session = useQuizSession((q, correct) => void recordAttempt(q, correct));

  const [difficulty, setDifficulty] = useState<Difficulty>("intermediate");
  const [count, setCount] = useState(10);
  const [types, setTypes] = useState<QuizType[]>(ALL_QUIZ_TYPES);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<ShownError | null>(null);

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

  async function handleGenerate() {
    if (!engine) {
      setError({ message: "Set up your engine in Settings first.", action: null });
      return;
    }
    if (!repo) return;
    setError(null);
    setGenerating(true);
    try {
      const result = await generateQuiz(engine, note, { count, difficulty, types });
      // Regenerate replaces the note's quiz rather than appending to it.
      await repo.replaceQuestions(note.id, result);
      setQuestions(result);
      session.reset();
    } catch (e) {
      // describeError() also raises the publik credit banner and carries
      // the single top-up link for a 402.
      setError(
        e instanceof EngineError
          ? describeError(e)
          : { message: "Could not generate the quiz. Please try again.", action: null },
      );
    } finally {
      setGenerating(false);
    }
  }

  async function recordAttempt(q: QuizQuestion, correct: boolean) {
    if (!repo) return;
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
  }

  async function handleReset() {
    if (!repo) return;
    await repo.resetQuiz(note.id);
    setAttempts([]);
    session.reset();
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
          <QuizSettings
            difficulty={difficulty}
            onDifficulty={setDifficulty}
            count={count}
            onCount={setCount}
            types={types}
            onTypes={setTypes}
          />
          <div className="mt-5 flex justify-end">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
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
            <div className="mt-4">
              <ErrorNotice err={error} onDismiss={() => setError(null)} />
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto mt-10 grid max-w-6xl gap-8 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-ink">Questions</h2>
              <span className="rounded-full bg-accent-softer px-3 py-1 text-xs font-bold text-accent">
                {session.score} / {questions.length} correct
              </span>
            </div>
            {questions.map((q, i) => (
              <QuestionCard key={q.id} index={i} {...session.cardProps(q)} />
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
