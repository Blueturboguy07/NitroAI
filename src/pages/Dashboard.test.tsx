// @vitest-environment jsdom
/* Regression test for the "New Folder" button: it used to render with no
   onClick handler at all, so clicking it silently did nothing — no modal, no
   folder, nothing persisted. See src/pages/Dashboard.tsx. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

describe("Dashboard — New Folder", () => {
  beforeEach(() => {
    // Fresh module graph per test: lib/app.tsx keeps a module-level repo
    // singleton, and prefs live in localStorage — both must reset so tests
    // don't leak folders/notes into each other.
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("creates and persists a folder when the button is clicked and a name submitted", async () => {
    const { AppProvider, getRepo } = await import("../lib/app");
    const { default: Dashboard } = await import("./Dashboard");

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AppProvider>
          <Dashboard />
        </AppProvider>
      </MemoryRouter>,
    );

    // No folders yet — the filter-chip row shouldn't render.
    expect(screen.queryByRole("button", { name: "Biology" })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /new folder/i }));

    const input = await screen.findByPlaceholderText("Folder name");
    await user.type(input, "Biology");
    await user.click(screen.getByRole("button", { name: /create folder/i }));

    // The modal closes and the new folder shows up as a selectable chip...
    expect(await screen.findByRole("button", { name: "Biology" })).toBeInTheDocument();

    // ...and it's actually persisted in the store, not just painted in the DOM.
    const repo = await getRepo();
    const folders = await repo.listFolders();
    expect(folders.map((f) => f.name)).toContain("Biology");
  });

  it("does nothing when the create-folder input is left blank", async () => {
    const { AppProvider, getRepo } = await import("../lib/app");
    const { default: Dashboard } = await import("./Dashboard");

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AppProvider>
          <Dashboard />
        </AppProvider>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: /new folder/i }));
    expect(screen.getByRole("button", { name: /create folder/i })).toBeDisabled();

    const repo = await getRepo();
    expect(await repo.listFolders()).toEqual([]);
  });

  it("deleting a folder keeps its notes and moves them up a level", async () => {
    const { AppProvider, getRepo } = await import("../lib/app");
    const { default: Dashboard } = await import("./Dashboard");
    const repo = await getRepo();
    await repo.putFolder({ id: "bio", name: "Biology", createdAt: 0, color: "grass" });
    await repo.putNote({
      id: "cells",
      title: "Cell membranes",
      sourceKind: "blank",
      sourceText: "",
      blocks: [],
      folderId: "bio",
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/?folder=bio"]}>
        <AppProvider>
          <Dashboard />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Biology" })).toBeInTheDocument();
    expect(screen.getByText("Cell membranes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Biology options" }));
    await user.click(await screen.findByRole("menuitem", { name: /delete folder, keep its notes/i }));

    expect(await repo.listFolders()).toEqual([]);
    expect((await repo.getNote("cells"))?.folderId).toBeUndefined();
  });

  it("shows the files a note was generated from on its card", async () => {
    const { AppProvider, getRepo } = await import("../lib/app");
    const { default: Dashboard } = await import("./Dashboard");
    const repo = await getRepo();
    await repo.putNote({
      id: "waves",
      title: "Wave mechanics",
      sourceKind: "pdf",
      sourceText: "",
      sourceFiles: ["lecture-07.pdf", "slides-07.pdf"],
      blocks: [],
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
    });

    render(
      <MemoryRouter>
        <AppProvider>
          <Dashboard />
        </AppProvider>
      </MemoryRouter>,
    );

    const label = await screen.findByText("lecture-07.pdf +1 more");
    expect(label.parentElement).toHaveAttribute("title", "lecture-07.pdf\nslides-07.pdf");
  });
});
