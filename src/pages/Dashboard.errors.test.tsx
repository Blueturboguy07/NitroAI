// @vitest-environment jsdom
/* The note-creation error banner used to sit on the folder page for good: no
   way to dismiss it, nothing to do about it. It now has a ✕, an "Open
   Settings" button when the engine is the problem, and keeps the picked files
   for the next try. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

describe("Dashboard — note creation errors", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(cleanup);

  it("can be dismissed, offers Settings, and keeps the picked files", async () => {
    const { AppProvider } = await import("../lib/app");
    const { default: Dashboard } = await import("./Dashboard");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AppProvider>
          <Dashboard />
        </AppProvider>
      </MemoryRouter>,
    );

    // No engine set up yet (fresh prefs): generating fails right away.
    await user.click(await screen.findByRole("button", { name: /Document upload/ }));
    const zone = screen.getByText(/Drag documents here/).closest("label")!;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["%PDF"], "lecture5.pdf", { type: "application/pdf" })] } });
    await user.click(screen.getByRole("button", { name: "Generate Notes" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Set up your engine in Settings first/);
    expect(screen.getByRole("button", { name: /Open Settings/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Reopening the same card still has the file picked.
    await user.click(screen.getByRole("button", { name: /Document upload/ }));
    expect(screen.getByText("lecture5.pdf")).toBeInTheDocument();
  });
});
