/* Quiz-mastery roll-up: pure aggregation over questions + attempts, no I/O. */

import type { QuizAttempt, QuizQuestion } from "../types";

export interface TopicMastery {
  topic: string;
  correct: number;
  total: number;
  pct: number;
}

/**
 * Roll up quiz attempts by topic. The set of topics is the distinct set of
 * `topic` values present in `questions` — a topic with no attempts yet still
 * appears, with total 0 / correct 0 / pct 0. Results are sorted by topic
 * name.
 */
export function masteryByTopic(
  questions: QuizQuestion[],
  attempts: QuizAttempt[],
): TopicMastery[] {
  const topics = Array.from(new Set(questions.map((q) => q.topic)));

  const rows = topics.map((topic): TopicMastery => {
    const topicAttempts = attempts.filter((a) => a.topic === topic);
    const total = topicAttempts.length;
    const correct = topicAttempts.filter((a) => a.correct).length;
    const pct = total ? Math.round((correct / total) * 100) : 0;
    return { topic, correct, total, pct };
  });

  rows.sort((a, b) => a.topic.localeCompare(b.topic));
  return rows;
}

/** Traffic-light color for a mastery percentage. */
export function masteryColor(pct: number): "red" | "amber" | "green" {
  if (pct < 50) return "red";
  if (pct < 80) return "amber";
  return "green";
}
