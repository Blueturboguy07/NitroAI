/* Flashcards tab: generate spaced-repetition cards from the note's content and
   run a study session against them. Self-contained — owns its own load/
   generate/review flow against the repo + engine from useApp(). */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useApp } from "../lib/app";
import { contentFor, generateFlashcards } from "../lib/generation";
import { bucketOf, reviewCard, studyOrder, type Rating } from "../lib/study/fsrs";
import { EngineError } from "../lib/engine/types";
import type { Flashcard, Note } from "../lib/types";

const RATINGS: { rating: Rating; label: string; className: string }[] = [
  {
    rating: "again",
    label: "Again",
    className: "bg-danger-soft text-danger-ink hover:opacity-90",
  },
  {
    rating: "hard",
    label: "Hard",
    className: "bg-callout-bg text-callout-ink hover:opacity-90",
  },
  {
    rating: "good",
    label: "Good",
    className: "bg-accent-soft text-ink hover:opacity-90",
  },
  {
    rating: "easy",
    label: "Easy",
    className: "bg-success-soft text-ink hover:opacity-90",
  },
];

/* Cards currently due, in the priority order a study session should present
   them (new -> learning/relearning -> review, soonest due first). */
function dueQueueOf(cards: Flashcard[]): Flashcard[] {
  const now = Date.now();
  return studyOrder(cards, now).filter((c) => c.due <= now);
}

export default function FlashcardsView({ note }: { note: Note }) {
  const { repo, engine } = useApp();

  const [loaded, setLoaded] = useState(false);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [flipped, setFlipped] = useState(false);
  const [sessionTotal, setSessionTotal] = useState(0);
  /* Set only while replaying a finished session via "Study again" — a fixed
     snapshot walked by index, ignoring due dates entirely. Null = normal
     due-driven session. */
  const [cycleQueue, setCycleQueue] = useState<Flashcard[] | null>(null);
  const [cycleIndex, setCycleIndex] = useState(0);

  // Load this note's cards whenever the note changes.
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError(null);
    setFlipped(false);
    setCycleQueue(null);
    setCycleIndex(0);
    if (!repo) return;
    (async () => {
      const cs = await repo.cardsFor(note.id);
      if (!alive) return;
      setCards(cs);
      setSessionTotal(dueQueueOf(cs).length);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [repo, note.id]);

  const content = contentFor(note);
  const isEmpty = !content.trim();

  // Recomputed fresh from `cards` every render: as reviewed cards' due dates
  // move into the future they naturally fall out of this queue, so the next
  // due card just appears without any extra bookkeeping.
  const dueQueue = useMemo(() => dueQueueOf(cards), [cards]);
  const counts = useMemo(() => {
    const c = { new: 0, learning: 0, mastered: 0 };
    for (const card of cards) c[bucketOf(card)]++;
    return c;
  }, [cards]);

  const current: Flashcard | undefined = cycleQueue
    ? cycleQueue[cycleIndex]
    : dueQueue[0];
  const sessionActive = cycleQueue
    ? cycleIndex < cycleQueue.length
    : dueQueue.length > 0;
  const reviewedSoFar = cycleQueue
    ? cycleIndex
    : Math.max(0, sessionTotal - dueQueue.length);

  async function handleGenerate() {
    if (!engine) {
      setError("Set up your engine in Settings first.");
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      const result = await generateFlashcards(engine, note);
      if (repo) await repo.putCards(result);
      setCards(result);
      setSessionTotal(dueQueueOf(result).length);
      setCycleQueue(null);
      setCycleIndex(0);
      setFlipped(false);
    } catch (e) {
      setError(
        e instanceof EngineError
          ? e.message
          : "Could not generate flashcards. Please try again.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleRate(rating: Rating) {
    if (!current || !repo) return;
    const updated = reviewCard(current, rating);
    await repo.putCard(updated);
    setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    if (cycleQueue) setCycleIndex((i) => i + 1);
    setFlipped(false);
  }

  function handleStudyAgain() {
    const q = studyOrder(cards);
    setCycleQueue(q);
    setCycleIndex(0);
    setSessionTotal(q.length);
    setFlipped(false);
  }

  return (
    <div className="px-16 py-12">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold">Welcome to Flashcards</h1>
        <p className="mt-2 text-ink-faint">Study your notes with spaced repetition.</p>
      </div>

      {isEmpty ? (
        <div className="mx-auto mt-10 max-w-4xl rounded-card bg-callout-bg p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="size-5 text-callout-ink" />
            <span className="font-display font-bold">Document is empty!</span>
          </div>
          <p className="mt-3 pl-8 text-ink-dim">
            Add some notes to your document to generate flashcards. Flashcards
            are created based on the notes in your document.
          </p>
        </div>
      ) : !loaded ? (
        <div className="mt-16 flex justify-center text-ink-faint">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : cards.length === 0 ? (
        <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className={`flex items-center gap-2 rounded-xl px-6 py-3 font-display font-bold transition ${
              !generating
                ? "bg-accent text-white hover:bg-accent-hover"
                : "cursor-not-allowed bg-accent-softer text-ink-faint"
            }`}
          >
            {generating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {generating ? "Building flashcards…" : "Generate flashcards"}
          </button>
          {error && (
            <div className="flex w-full items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-ink">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto mt-8 max-w-2xl">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Pill label="New" count={counts.new} className="text-ink-dim" />
              <Pill label="Learning" count={counts.learning} className="text-callout-ink" />
              <Pill label="Mastered" count={counts.mastered} className="text-green-600" />
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-ink-dim shadow-soft hover:bg-card-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {generating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {generating ? "Regenerating…" : "Regenerate"}
            </button>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-ink">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-8">
            {current && sessionActive ? (
              <>
                <p className="mb-3 text-center text-sm font-semibold text-ink-faint">
                  Card {reviewedSoFar + 1} of {sessionTotal}
                </p>
                <button
                  onClick={() => setFlipped((f) => !f)}
                  className="flex min-h-64 w-full flex-col items-center justify-center gap-4 rounded-card border border-edge bg-card p-10 text-center shadow-soft transition hover:shadow-md"
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    {flipped ? "Answer" : "Question"}
                  </span>
                  <p className="font-display text-xl font-semibold text-ink">
                    {flipped ? current.back : current.front}
                  </p>
                  {!flipped && (
                    <p className="text-xs text-ink-faint">Click to reveal answer</p>
                  )}
                </button>

                {flipped && (
                  <div className="mt-6 grid grid-cols-4 gap-3">
                    {RATINGS.map(({ rating, label, className }) => (
                      <button
                        key={rating}
                        onClick={() => handleRate(rating)}
                        className={`rounded-xl px-4 py-2.5 font-display text-sm font-bold transition ${className}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center gap-4 py-12 text-center">
                <Layers className="size-8 text-accent" />
                <p className="font-display text-2xl font-bold">
                  You're all caught up! 🎉
                </p>
                <p className="text-ink-dim">No cards are due for review right now.</p>
                <button
                  onClick={handleStudyAgain}
                  className="rounded-xl bg-accent px-6 py-3 font-display text-sm font-bold text-white hover:bg-accent-hover"
                >
                  Study again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Pill({
  label,
  count,
  className,
}: {
  label: string;
  count: number;
  className: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-edge bg-card px-3 py-1 text-xs font-semibold shadow-soft">
      <span className={className}>{count}</span>
      <span className="text-ink-faint">{label}</span>
    </div>
  );
}
