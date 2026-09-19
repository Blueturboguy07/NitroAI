// @vitest-environment jsdom
/* bugfix-lab oracle for nitroai-new-folder-button-noop.
   Written independently of the app's own regression test so it observes
   BEHAVIOUR against any revision (pre-fix or post-fix) rather than depending
   on a patch already being present. Renders the real Dashboard, clicks the
   'New Folder' button exactly as a user would (top-right of the notes list,
   per bug report 62fc4e64 + screenshot from adjacent report 1b6bffe2), types
   a folder name, submits, and asserts a folder is actually created AND
   persisted via the repo. On the pre-fix Dashboard (button has no onClick)
   the modal never appears and this test times out / fails -- that failure
   IS the reproduction, not a tautology about source text. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

describe("bugfix-lab oracle: Dashboard New Folder button", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("BUGFIX_LAB: clicking New Folder actually creates and persists a folder", async () => {
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

    const newFolderButton = await screen.findByRole("button", { name: /new folder/i });
    await user.click(newFolderButton);

    // Give a no-op handler a moment to (not) do anything before we look for
    // the modal, rather than racing findBy's own retry timeout away.
    const input = await screen.findByPlaceholderText(/folder name/i, {}, { timeout: 3000 });
    await user.type(input, "BugfixLabOracleFolder");
    await user.click(screen.getByRole("button", { name: /create folder/i }));

    expect(
      await screen.findByRole("button", { name: "BugfixLabOracleFolder" }),
    ).toBeInTheDocument();

    const repo = await getRepo();
    const folders = await repo.listFolders();
    expect(folders.map((f: { name: string }) => f.name)).toContain("BugfixLabOracleFolder");
  });
});
