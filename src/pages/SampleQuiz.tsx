/* Sample quiz: one quiz drawn from exactly the courses, units and lessons the
   user ticks. Generated in a single request; short-answer model answers come
   back with it, so revealing one is instant. Scored for this sitting only —
   per-lesson mastery stays with each note's own Quiz tab. */

import { useMemo, useState } from "react";
import { ListChecks, Loader2, RotateCcw, Shuffle } from "lucide-react";
import { useApp } from "../lib/app";
import { ALL_QUIZ_TYPES, generateSampleQuiz } from "../lib/generation";
import { EngineError } from "../lib/engine/types";
import { describeError, type ShownError } from "../lib/publik";
import { ErrorNotice } from "../components/PublikNotice";
import { pathTo } from "../lib/library";
import { masteryColor } from "../lib/study/mastery";
import type { QuizQuestion, QuizType } from "../lib/types";
import { useLibrary } from "../components/library/useLibrary";
import ScopePicker from "../components/quiz/ScopePicker";
import { QuestionCard, QuizSettings, useQuizSession, type Difficulty } from "../components/quiz/QuestionCard";

const SELECTION_KEY = "nitroai.sampleQuiz.selected";

function loadSelection(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveSelection(ids: Set<string>) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable */
  }
}

export default function SampleQuiz() {
  const { engine } = useApp();
  const lib = useLibrary();

  const [picked, setPicked] = useState<Set<string>>(loadSelection);
  const [difficulty, setDifficulty] = useState<Difficulty>("intermediate");
  const [count, setCount] = useState(10);
  const [types, setTypes] = useState<QuizType[]>(ALL_QUIZ_TYPES);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<ShownError | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const session = useQuizSession();

  // Only lessons that still exist count as selected.
  const selected = useMemo(() => new Set(lib.notes.filter((n) => picked.has(n.id)).map((n) => n.id)), [lib.notes, picked]);
  const lessonLabel = useMemo(() => {
    const labels = new Map<string, string>();
    for (const n of lib.notes) {
      labels.set(n.id, [...pathTo(lib.folders, n.folderId).map((f) => f.name), n.title].join(" / "));
    }
    return labels;
  }, [lib.notes, lib.folders]);

  function select(next: Set<string>) {
    setPicked(next);
    saveSelection(next);
  }

  async function handleGenerate() {
    if (!engine) {
      setError({ message: "Set up your engine in Settings first.", action: null });
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      const lessons = lib.notes.filter((n) => selected.has(n.id));
      setQuestions(await generateSampleQuiz(engine, lessons, { count, difficulty, types }));
      session.reset();
    } catch (e) {
      setError(
        e instanceof EngineError
          ? describeError(e)
          : { message: "Could not generate the quiz. Please try again.", action: null },
      );
    } finally {
      setGenerating(false);
    }
  }

  function newQuiz() {
    setQuestions([]);
    session.reset();
  }

  return (
    <div className="px-10 py-8">
      <div className="flex items-center gap-3">
        <Shuffle className="size-6 text-accent" />
        <h1 className="text-4xl font-bold tracking-tight">Sample quiz</h1>
      </div>
      <p className="mt-2 text-ink-faint">
        Pick exactly which courses, units or lessons to be tested on, and get one quiz across all of them.
      </p>

      {!lib.loaded ? (
        <div className="mt-16 flex items-center justify-center gap-2 text-ink-faint">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-sm font-semibold">Loading your library…</span>
        </div>
      ) : lib.notes.length === 0 ? (
        <div className="mt-8 max-w-xl rounded-card bg-callout-bg p-6 text-callout-ink">
          <p className="font-display font-bold">No lessons yet</p>
          <p className="mt-1 text-sm">Create a few notes first, then come back to quiz yourself across them.</p>
        </div>
      ) : questions.length === 0 ? (
        <div className="mt-8 grid max-w-5xl gap-6 lg:grid-cols-[1fr_360px]">
          <section className="min-w-0 rounded-card border border-edge bg-card p-5 shadow-soft">
            <h2 className="font-display text-sm font-bold text-ink">What to cover</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Tick a course to include everything in it, or open it to pick single units and lessons.
            </p>
            <div className="mt-4 max-h-[60vh] overflow-y-auto pr-1">
              <ScopePicker folders={lib.folders} notes={lib.notes} selected={selected} onChange={select} />
            </div>
          </section>

          <section className="h-fit rounded-card border border-edge bg-card p-5 shadow-soft lg:sticky lg:top-8">
            <QuizSettings
              difficulty={difficulty}
              onDifficulty={setDifficulty}
              count={count}
              onCount={setCount}
              types={types}
              onTypes={setTypes}
              counts={[5, 10, 15, 20]}
            />
            <button
              onClick={handleGenerate}
              disabled={generating || selected.size === 0}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {generating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Building your quiz…
                </>
              ) : (
                <>
                  <ListChecks className="size-4" />
                  {selected.size ? `Quiz me on ${selected.size === 1 ? "1 lesson" : `${selected.size} lessons`}` : "Pick some lessons first"}
                </>
              )}
            </button>
            {error && (
              <div className="mt-4">
                <ErrorNotice err={error} onDismiss={() => setError(null)} />
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="mt-8 grid max-w-6xl gap-8 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-ink">Questions</h2>
              <span className="rounded-full bg-accent-softer px-3 py-1 text-xs font-bold text-accent">
                {session.score} / {questions.length} correct
              </span>
            </div>
            {questions.map((q, i) => (
              <QuestionCard key={q.id} index={i} lesson={lessonLabel.get(q.noteId)} {...session.cardProps(q)} />
            ))}
          </div>

          <LessonScores
            questions={questions}
            answered={session.answered}
            label={(id) => lib.notes.find((n) => n.id === id)?.title ?? "Deleted lesson"}
            onRetake={session.reset}
            onNew={newQuiz}
          />
        </div>
      )}
    </div>
  );
}

function LessonScores({
  questions,
  answered,
  label,
  onRetake,
  onNew,
}: {
  questions: QuizQuestion[];
  answered: ReturnType<typeof useQuizSession>["answered"];
  label: (noteId: string) => string;
  onRetake: () => void;
  onNew: () => void;
}) {
  const rows = useMemo(() => {
    const byLesson = new Map<string, { total: number; done: number; correct: number }>();
    for (const q of questions) {
      const row = byLesson.get(q.noteId) ?? { total: 0, done: 0, correct: 0 };
      row.total++;
      if (answered[q.id]) row.done++;
      if (answered[q.id]?.correct) row.correct++;
      byLesson.set(q.noteId, row);
    }
    return [...byLesson].map(([noteId, r]) => ({ noteId, ...r, pct: r.done ? Math.round((r.correct / r.done) * 100) : 0 }));
  }, [questions, answered]);

  return (
    <aside className="h-fit rounded-card border border-edge bg-card p-5 shadow-soft lg:sticky lg:top-8">
      <h2 className="font-display text-sm font-bold text-ink">Score by lesson</h2>
      <div className="mt-4 space-y-4">
        {rows.map((r) => {
          const color = masteryColor(r.pct);
          const barClass = !r.done ? "bg-transparent" : color === "green" ? "bg-green-500" : color === "amber" ? "bg-amber-500" : "bg-red-500";
          return (
            <div key={r.noteId}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate font-semibold text-ink">{label(r.noteId)}</span>
                <span className="shrink-0 text-xs text-ink-faint">
                  {r.correct}/{r.done} · {r.total} q
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-panel">
                <div className={`h-full rounded-full ${barClass}`} style={{ width: `${r.pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-5 flex gap-2 border-t border-edge pt-4">
        <button
          onClick={onRetake}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-edge bg-panel px-3 py-2 text-sm font-semibold hover:bg-card-hover"
        >
          <RotateCcw className="size-3.5" />
          Retake
        </button>
        <button
          onClick={onNew}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-bold text-white hover:bg-accent-hover"
        >
          <ListChecks className="size-3.5" />
          New quiz
        </button>
      </div>
    </aside>
  );
}
