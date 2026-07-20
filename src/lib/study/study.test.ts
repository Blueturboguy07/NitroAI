import { describe, expect, it } from "vitest";
import type { Flashcard, QuizAttempt, QuizQuestion } from "../types";
import { bucketOf, dueCards, newCardState, reviewCard, studyOrder } from "./fsrs";
import { masteryByTopic, masteryColor } from "./mastery";

const NOW = 1_700_000_000_000; // fixed epoch ms for determinism
const DAY = 86_400_000;

function makeCard(overrides: Partial<Flashcard> = {}): Flashcard {
  return {
    id: overrides.id ?? "card-1",
    noteId: "note-1",
    front: "What is photosynthesis?",
    back: "The process by which plants convert light into chemical energy.",
    topic: "biology",
    ...newCardState(NOW),
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: overrides.id ?? "q-1",
    noteId: "note-1",
    type: "mcq",
    topic: "biology",
    difficulty: "basic",
    question: "What pigment absorbs light in photosynthesis?",
    options: ["Chlorophyll", "Melanin", "Keratin", "Hemoglobin"],
    correctIndex: 0,
    explanation: "Chlorophyll absorbs light for photosynthesis.",
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<QuizAttempt> = {}): QuizAttempt {
  return {
    id: overrides.id ?? "attempt-1",
    noteId: "note-1",
    questionId: "q-1",
    topic: "biology",
    correct: true,
    at: NOW,
    ...overrides,
  };
}

describe("newCardState", () => {
  it("produces a fresh 'new' card due now", () => {
    const state = newCardState(NOW);
    expect(state.state).toBe("new");
    expect(state.reps).toBe(0);
    expect(state.lapses).toBe(0);
    expect(state.stability).toBe(0);
    expect(state.due).toBe(NOW);
  });
});

describe("reviewCard", () => {
  it("'good' pushes due into the future and increments reps", () => {
    const card = makeCard();
    const reviewed = reviewCard(card, "good", NOW);

    expect(reviewed.reps).toBe(card.reps + 1);
    expect(reviewed.due).toBeGreaterThan(NOW);
    expect(reviewed.lastReview).toBe(NOW);
    expect(reviewed.stability).toBeGreaterThan(0);
  });

  it("does not mutate the input card", () => {
    const card = makeCard();
    const snapshot = { ...card };
    reviewCard(card, "good", NOW);
    expect(card).toEqual(snapshot);
  });

  it("'again' increments lapses and yields a much shorter interval than 'good'", () => {
    const card = makeCard();
    const good = reviewCard(card, "good", NOW);
    const again = reviewCard(card, "again", NOW);

    expect(again.lapses).toBe(card.lapses + 1);
    expect(again.due).toBeGreaterThan(NOW); // still positive/forward interval
    expect(again.due - NOW).toBeLessThan(good.due - NOW);
    expect(again.stability).toBeGreaterThan(0); // stability stays strictly positive
  });

  it("moves a new card into 'learning' on 'good', then 'review' on the next success", () => {
    const card = makeCard(); // state: "new"
    const afterGood = reviewCard(card, "good", NOW);
    expect(afterGood.state).toBe("learning");

    const afterSecond = reviewCard(afterGood, "good", NOW + DAY);
    expect(afterSecond.state).toBe("review");
  });

  it("lapsing a review card sends it to 'relearning'", () => {
    const reviewCardState = makeCard({
      state: "review",
      stability: 30,
      reps: 5,
    });
    const lapsed = reviewCard(reviewCardState, "again", NOW);
    expect(lapsed.state).toBe("relearning");
  });

  it("keeps difficulty clamped within 1..10", () => {
    let card = makeCard({ difficulty: 9.7 });
    for (let i = 0; i < 5; i++) {
      card = reviewCard(card, "again", NOW + i * DAY);
    }
    expect(card.difficulty).toBeLessThanOrEqual(10);

    let easyCard = makeCard({ difficulty: 1.3, state: "review", stability: 5 });
    for (let i = 0; i < 5; i++) {
      easyCard = reviewCard(easyCard, "easy", NOW + i * DAY);
    }
    expect(easyCard.difficulty).toBeGreaterThanOrEqual(1);
  });
});

describe("bucketOf", () => {
  it("classifies an untouched card as 'new'", () => {
    const card = makeCard();
    expect(bucketOf(card, NOW)).toBe("new");
  });

  it("classifies a reviewed, not-yet-mastered card as 'learning'", () => {
    const card = makeCard({ state: "learning", reps: 1, stability: 2 });
    expect(bucketOf(card, NOW)).toBe("learning");
  });

  it("classifies a review card with a short interval as still 'learning'", () => {
    const card = makeCard({ state: "review", reps: 3, stability: 10 });
    expect(bucketOf(card, NOW)).toBe("learning");
  });

  it("classifies a review card with stability >= 21 days as 'mastered'", () => {
    const card = makeCard({ state: "review", reps: 6, stability: 25 });
    expect(bucketOf(card, NOW)).toBe("mastered");
  });
});

describe("dueCards / studyOrder", () => {
  it("dueCards returns only due cards, sorted by due ascending", () => {
    const soon = makeCard({ id: "soon", due: NOW - 1000 });
    const now = makeCard({ id: "now", due: NOW });
    const future = makeCard({ id: "future", due: NOW + DAY });
    const result = dueCards([future, now, soon], NOW);
    expect(result.map((c) => c.id)).toEqual(["soon", "now"]);
  });

  it("studyOrder puts due new cards before due learning/review cards, then not-due cards", () => {
    const dueReview = makeCard({ id: "due-review", state: "review", due: NOW - 10, stability: 30, reps: 5 });
    const dueLearning = makeCard({ id: "due-learning", state: "learning", due: NOW - 5, reps: 1 });
    const dueNew = makeCard({ id: "due-new", state: "new", due: NOW - 1 });
    const notDue = makeCard({ id: "not-due", state: "new", due: NOW + DAY });

    const order = studyOrder([dueReview, dueLearning, dueNew, notDue], NOW);
    expect(order.map((c) => c.id)).toEqual([
      "due-new",
      "due-learning",
      "due-review",
      "not-due",
    ]);
  });
});

describe("masteryByTopic", () => {
  it("rolls up correct/total/pct per topic present in questions", () => {
    const questions = [
      makeQuestion({ id: "q-bio-1", topic: "biology" }),
      makeQuestion({ id: "q-bio-2", topic: "biology" }),
      makeQuestion({ id: "q-chem-1", topic: "chemistry" }),
    ];
    const attempts = [
      makeAttempt({ id: "a1", questionId: "q-bio-1", topic: "biology", correct: true }),
      makeAttempt({ id: "a2", questionId: "q-bio-2", topic: "biology", correct: false }),
      makeAttempt({ id: "a3", questionId: "q-bio-1", topic: "biology", correct: true }),
      // chemistry has zero attempts
    ];

    const result = masteryByTopic(questions, attempts);

    expect(result).toEqual([
      { topic: "biology", correct: 2, total: 3, pct: 67 },
      { topic: "chemistry", correct: 0, total: 0, pct: 0 },
    ]);
  });

  it("sorts topics by name and ignores attempts for topics not in questions", () => {
    const questions = [
      makeQuestion({ id: "q1", topic: "zoology" }),
      makeQuestion({ id: "q2", topic: "algebra" }),
    ];
    const attempts = [
      makeAttempt({ id: "a1", topic: "algebra", correct: true }),
      makeAttempt({ id: "a2", topic: "unrelated-topic", correct: true }),
    ];

    const result = masteryByTopic(questions, attempts);
    expect(result.map((r) => r.topic)).toEqual(["algebra", "zoology"]);
    expect(result.find((r) => r.topic === "algebra")).toEqual({
      topic: "algebra",
      correct: 1,
      total: 1,
      pct: 100,
    });
  });
});

describe("masteryColor", () => {
  it("is red below 50", () => {
    expect(masteryColor(0)).toBe("red");
    expect(masteryColor(49)).toBe("red");
  });

  it("is amber from 50 up to (not including) 80", () => {
    expect(masteryColor(50)).toBe("amber");
    expect(masteryColor(79)).toBe("amber");
  });

  it("is green at 80 and above", () => {
    expect(masteryColor(80)).toBe("green");
    expect(masteryColor(100)).toBe("green");
  });
});
