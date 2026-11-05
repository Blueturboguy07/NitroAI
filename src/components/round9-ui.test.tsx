// @vitest-environment jsdom
/* Round 9, item 4 (small, old). From the NitroAI 0.2.3 release smoke test:
   - a flashcard answer showed raw Markdown ("**oceans**");
   - the note's "Version history" button had no action at all;
   - the Dashboard error of an earlier failed try stayed on screen while the
     user started the next thing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Note } from "../lib/types";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(cleanup);

function note(): Note {
  const t = Date.now();
  return { id: "note-r9", title: "Water cycle", sourceKind: "text", sourceText: "Water evaporates from the oceans.", blocks: [{ id: "b1", type: "paragraph", text: "Water evaporates from the **oceans**." }], createdAt: t, updatedAt: t, lastOpenedAt: t };
}

describe("flashcards show Markdown as formatting", () => {
  it('the answer "Most water evaporates from the **oceans**." shows bold "oceans", with no asterisks', async () => {
    const { AppProvider, getRepo } = await import("../lib/app");
    const { default: FlashcardsView } = await import("./FlashcardsView");
    const { newCardState } = await import("../lib/study/fsrs");
    const repo = await getRepo();
    const n = note();
    await repo.putNote(n);
    await repo.putCards([{ id: "c1", noteId: n.id, front: "Where does **most** evaporation happen?", back: "Most water evaporates from the **oceans**.", topic: "Evaporation", ...newCardState() }]);
    const user = userEvent.setup();
    render(
      <AppProvider>
        <FlashcardsView note={n} />
      </AppProvider>,
    );
    const front = await screen.findByText(/evaporation happen\?/);
    expect(front.textContent).toBe("Where does most evaporation happen?");
    expect(front.querySelector("strong")?.textContent).toBe("most");
    await user.click(front.closest("button")!);
    const back = await screen.findByText(/Most water evaporates/);
    expect(back.textContent).toBe("Most water evaporates from the oceans.");
    expect(back.querySelector("strong")?.textContent).toBe("oceans");
  });
});

describe("the note header has no dead button", () => {
  it('no "Version history" button (it did nothing); every header button has an action', async () => {
    const { AppProvider, getRepo } = await import("../lib/app");
    const { default: NoteView } = await import("../pages/NoteView");
    const repo = await getRepo();
    await repo.putNote(note());
    render(
      <MemoryRouter initialEntries={["/notes/note-r9/editor"]}>
        <AppProvider>
          <Routes>
            <Route path="/notes/:id/:view" element={<NoteView />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    await screen.findByDisplayValue("Water cycle");
    expect(screen.queryByRole("button", { name: "Version history" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});

describe("Dashboard: an old error does not stay", () => {
  it("the error of a failed Generate goes away when the user opens the next card", async () => {
    const { AppProvider } = await import("../lib/app");
    const { default: Dashboard } = await import("../pages/Dashboard");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AppProvider>
          <Dashboard />
        </AppProvider>
      </MemoryRouter>,
    );
    // No engine is set up, so Generate fails with an error on the Dashboard.
    await user.click((await screen.findByText("Website link")).closest("button")!);
    await user.type(await screen.findByPlaceholderText("Paste a website or YouTube link..."), "https://en.wikipedia.org/wiki/Water_cycle");
    await user.click(screen.getByRole("button", { name: "Generate Notes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Set up your engine in Settings first");
    // The next action starts clean.
    await user.click(screen.getByText("Document upload").closest("button")!);
    await waitFor(() => expect(screen.queryByText(/Set up your engine in Settings first/)).not.toBeInTheDocument());
  });
});
