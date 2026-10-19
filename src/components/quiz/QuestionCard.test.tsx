// @vitest-environment jsdom
/* Short answers: the model answer ships with the question, so "Reveal answer"
   shows it immediately (no request), then the learner grades themselves. */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QuizQuestion } from "../../lib/types";
import { QuestionCard, isCorrect, useQuizSession } from "./QuestionCard";

const question = (over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: "q1",
  noteId: "n1",
  type: "short_answer",
  topic: "Cells",
  difficulty: "intermediate",
  question: "Why do cells need a membrane?",
  options: ["To control what enters and leaves the cell."],
  correctIndex: 0,
  explanation: "The membrane is selectively permeable.",
  ...over,
});

function Harness({ q, onAnswered }: { q: QuizQuestion; onAnswered?: (q: QuizQuestion, correct: boolean) => void }) {
  const session = useQuizSession(onAnswered);
  return (
    <>
      <QuestionCard index={0} lesson="Biology / Cells" {...session.cardProps(q)} />
      <span data-testid="score">{session.score}</span>
      <button onClick={session.reset}>reset</button>
    </>
  );
}

afterEach(cleanup);

describe("short answer questions", () => {
  it("hides the model answer until revealed, then lets the learner grade themselves", async () => {
    const onAnswered = vi.fn();
    render(<Harness q={question()} onAnswered={onAnswered} />);
    expect(screen.getByText("Biology / Cells")).toBeInTheDocument();
    expect(screen.queryByText(/To control what enters/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/Write your answer/), "It keeps things in");
    await userEvent.click(screen.getByRole("button", { name: /Reveal answer/ }));

    expect(screen.getByText(/To control what enters/)).toBeInTheDocument();
    expect(screen.getByText(/selectively permeable/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Write your answer/)).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /Got it/ }));
    expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }), true);
    expect(screen.getByTestId("score")).toHaveTextContent("1");
    expect(screen.queryByRole("button", { name: /Got it/ })).not.toBeInTheDocument();
  });

  it("can be revealed without typing, and a reset hides it again", async () => {
    render(<Harness q={question()} />);
    await userEvent.click(screen.getByRole("button", { name: /Reveal answer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Not quite/ }));
    expect(screen.getByTestId("score")).toHaveTextContent("0");

    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.queryByText(/To control what enters/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reveal answer/ })).toBeInTheDocument();
  });
});

describe("question text", () => {
  it("renders inline Markdown and $…$ math instead of raw source", async () => {
    const { container } = render(
      <Harness
        q={question({
          type: "mcq",
          question: "For which **integers** is $4 \\le x \\le 8$ true?",
          options: ["$x = 5$", "$x = 9$", "$x = 2$", "$x = 0$"],
          explanation: "Only $5$ lies in $[4, 8]$.",
        })}
      />,
    );
    expect(container.querySelector("strong")).toHaveTextContent("integers");
    expect(container.textContent).not.toContain("$");
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(5);

    await userEvent.click(screen.getAllByRole("button")[0]);
    expect(container.textContent).not.toContain("$");
  });
});

describe("auto-graded questions", () => {
  it("matches fill-in-the-blank answers loosely and choices by index", () => {
    expect(isCorrect(question({ type: "fill_blank", options: ["Mitochondria"] }), "  mitochondria ")).toBe(true);
    expect(isCorrect(question({ type: "fill_blank", options: ["**acceleration**"] }), "Acceleration")).toBe(true);
    expect(isCorrect(question({ type: "fill_blank", options: ["*Mitosis*."] }), "mitosis")).toBe(true);
    expect(isCorrect(question({ type: "fill_blank", options: ["$x^2 + 1$"] }), "x^2+1")).toBe(true);
    expect(isCorrect(question({ type: "fill_blank", options: ["$x^2$"] }), "x^3")).toBe(false);
    expect(isCorrect(question({ type: "mcq", options: ["a", "b"], correctIndex: 1 }), 1)).toBe(true);
    expect(isCorrect(question({ type: "mcq", options: ["a", "b"], correctIndex: 1 }), 0)).toBe(false);
  });
});
