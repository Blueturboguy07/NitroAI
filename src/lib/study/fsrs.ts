/* Simplified FSRS/SM-2-style spaced-repetition scheduler.
   Pure functions only — no I/O, no ambient clock reads except via the
   optional `nowMs` parameter (defaults to Date.now() at the call site).

   Model summary:
   - `stability` is the estimated memory strength, expressed in days: a card
     with stability S is expected to still be recallable roughly S days from
     its last successful review. It only ever grows on a successful review
     and only ever shrinks (never below a small positive floor) on a lapse.
   - `difficulty` is a 1..10 ease knob: harder ratings push it up (toward 10,
     "hard to remember"), easier ratings pull it down (toward 1). It is kept
     mostly for display/telemetry — the scheduling math below keys off
     `rating` directly to stay simple and monotonic.
   - `state` walks new -> learning -> review, and review -> relearning on a
     lapse ("again"); relearning walks back to review on the next success.
   - The next interval in days is derived from the new stability for
     successful ratings, or a short fixed relearn step for "again". The next
     `due` timestamp is simply `nowMs + intervalDays * 86_400_000`.
*/

import type { Flashcard } from "../types";

export type Rating = "again" | "hard" | "good" | "easy";

const MS_PER_DAY = 86_400_000;

/* A brand-new card starts with no measured stability and mid-range
   difficulty; it is due immediately so it surfaces in the first session. */
const INITIAL_DIFFICULTY = 5;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;

/* Stability (days) is seeded to at least this floor before being scaled by
   the rating factor below, so a fresh card (stability 0) still produces a
   sensible first interval instead of multiplying by zero. */
const MIN_STABILITY_SEED = 1;

/* A lapse ("again") shrinks stability instead of zeroing it out — some
   memory trace survives a single missed review — but never below this
   floor, keeping stability strictly positive per the scheduling contract. */
const LAPSE_STABILITY_DECAY = 0.2;
const MIN_STABILITY_AFTER_LAPSE = 0.5;

/* Short relearn step used for the "again" interval (10 minutes), independent
   of the longer-term stability estimate. */
const RELEARN_INTERVAL_DAYS = 10 / 1440;

const STABILITY_FACTOR: Record<"hard" | "good" | "easy", number> = {
  hard: 1.2,
  good: 2.0,
  easy: 2.8,
};

const DIFFICULTY_DELTA: Record<Rating, number> = {
  again: 1,
  hard: 0.5,
  good: -0.1,
  easy: -0.5,
};

function clampDifficulty(d: number): number {
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, d));
}

/** Fresh scheduling state for a brand-new card, due immediately. */
export function newCardState(
  nowMs: number = Date.now(),
): Pick<
  Flashcard,
  "due" | "stability" | "difficulty" | "reps" | "lapses" | "state" | "lastReview"
> {
  return {
    due: nowMs,
    stability: 0,
    difficulty: INITIAL_DIFFICULTY,
    reps: 0,
    lapses: 0,
    state: "new",
    lastReview: undefined,
  };
}

/**
 * Apply one review rating to a card and return a NEW card object with
 * updated scheduling fields (all other fields — id, front, back, topic, ...
 * — are carried over unchanged).
 */
export function reviewCard(
  card: Flashcard,
  rating: Rating,
  nowMs: number = Date.now(),
): Flashcard {
  const reps = card.reps + 1;
  let lapses = card.lapses;
  const difficulty = clampDifficulty(card.difficulty + DIFFICULTY_DELTA[rating]);
  let stability: number;
  let intervalDays: number;
  let state: Flashcard["state"];

  if (rating === "again") {
    lapses += 1;
    stability = Math.max(
      card.stability * LAPSE_STABILITY_DECAY,
      MIN_STABILITY_AFTER_LAPSE,
    );
    intervalDays = RELEARN_INTERVAL_DAYS;
    /* A card that had already graduated to review (or was already mid
       relearn) goes into relearning; a card still new/learning just stays
       in learning — it never "graduated" yet, so there is nothing to lapse
       out of. */
    state =
      card.state === "review" || card.state === "relearning"
        ? "relearning"
        : "learning";
  } else {
    const seeded = Math.max(card.stability, MIN_STABILITY_SEED);
    stability = seeded * STABILITY_FACTOR[rating];
    intervalDays = stability;

    if (card.state === "new") {
      /* An "easy" first review fast-tracks straight to review (the learner
         already knows it); "hard"/"good" still spend one step in learning. */
      state = rating === "easy" ? "review" : "learning";
    } else {
      /* learning, relearning, and review all graduate/stay in review on a
         successful rating. */
      state = "review";
    }
  }

  const due = nowMs + intervalDays * MS_PER_DAY;

  return {
    ...card,
    due,
    stability,
    difficulty,
    reps,
    lapses,
    lastReview: nowMs,
    state,
  };
}

/** Mastery threshold, in days of stability, for a "review" card to count
    as mastered rather than merely "learning". */
const MASTERED_STABILITY_DAYS = 21;

/**
 * Coarse study-progress bucket for a card, independent of whether it is
 * currently due. `nowMs` is accepted for API symmetry with the rest of this
 * module (and room for future due-aware bucketing) but the current rule is
 * a pure function of `reps`/`state`/`stability`.
 */
export function bucketOf(
  card: Flashcard,
  nowMs: number = Date.now(),
): "new" | "learning" | "mastered" {
  void nowMs;
  if (card.reps === 0 || card.state === "new") return "new";
  if (card.state === "review" && card.stability >= MASTERED_STABILITY_DAYS) {
    return "mastered";
  }
  return "learning";
}

/** Cards whose `due` has arrived (due <= now), soonest-due first. */
export function dueCards(
  cards: Flashcard[],
  nowMs: number = Date.now(),
): Flashcard[] {
  return cards
    .filter((c) => c.due <= nowMs)
    .slice()
    .sort((a, b) => a.due - b.due);
}

/* Ordering used to drive a study session: due new cards first, then due
   learning/relearning cards, then due review cards (ties broken by soonest
   due); any not-yet-due cards are appended after, soonest-due first, so the
   queue never runs dry. */
const STATE_PRIORITY: Record<Flashcard["state"], number> = {
  new: 0,
  learning: 1,
  relearning: 1,
  review: 2,
};

export function studyOrder(
  cards: Flashcard[],
  nowMs: number = Date.now(),
): Flashcard[] {
  const due = dueCards(cards, nowMs).sort((a, b) => {
    const p = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
    return p !== 0 ? p : a.due - b.due;
  });
  const notDue = cards
    .filter((c) => c.due > nowMs)
    .slice()
    .sort((a, b) => a.due - b.due);
  return [...due, ...notDue];
}
