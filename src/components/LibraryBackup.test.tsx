// @vitest-environment jsdom
/* The library backup in the UI, against a fake local server (no network):
   - the dashboard card on an empty library when the account has a backup
     (the reinstall / second-computer path), with the setting OFF;
   - the Settings card: the switch, "Back up now", "Last backup", restore;
   - the honest note "Your notes are stored on this computer only". */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACCOUNT_SNAPSHOT = JSON.stringify({
  format: "nitroai-library",
  version: 1,
  madeAt: "2026-11-18T09:30:00.000Z",
  collections: {
    notes: [{ id: "n1", title: "Cell biology", sourceKind: "blank", sourceText: "", blocks: [], createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }],
    folders: [],
    flashcards: [{ id: "c1", noteId: "n1", front: "Q", back: "A" }],
    quiz: [],
    attempts: [],
    chat: [],
    podcasts: [],
  },
});

interface Fake {
  calls: string[];
  posts: string[];
  backup: { id: string; text: string; created_at: string } | null;
  failPost: { status: number; type: string } | null;
}

function stubServer(opts: { backup?: boolean; publik?: boolean } = {}): Fake {
  const publik = opts.publik ?? true;
  const fake: Fake = {
    calls: [],
    posts: [],
    backup: opts.backup ? { id: "file_1", text: ACCOUNT_SNAPSHOT, created_at: "2026-11-18T09:30:00.000Z" } : null,
    failPost: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      fake.calls.push(`${method} ${url}`);
      if (url === "/api/publik/status") return json(publik ? { available: true, state: "ready", baseUrl: "/api/publik/v1", disclosureVersion: 2 } : { available: false, state: "unprovisioned", baseUrl: "/api/publik/v1" });
      if (url === "/api/publik/wallet") return json({ balance_micros: 5_000_000, claim_state: "claimed" });
      if (url.startsWith("/api/local/status")) return json({ installed: false, serving: false, hasChatModel: false, hasEmbedModel: false, models: [] });
      if (url === "/api/publik/backup" && method === "GET") {
        if (!publik) return json({ available: false, exists: false, id: null, bytes: null, created_at: null });
        return json(fake.backup ? { available: true, exists: true, id: fake.backup.id, bytes: fake.backup.text.length, created_at: fake.backup.created_at } : { available: true, exists: false, id: null, bytes: null, created_at: null });
      }
      if (url === "/api/publik/backup" && method === "POST") {
        if (fake.failPost) return json({ error: { type: fake.failPost.type, message: "x" } }, fake.failPost.status);
        const text = String(init.body);
        fake.posts.push(text);
        fake.backup = { id: `file_${fake.posts.length + 1}`, text, created_at: new Date().toISOString() };
        return json({ id: fake.backup.id, bytes: text.length, created_at: fake.backup.created_at, charge_micros: 13000 });
      }
      if (url === "/api/publik/backup/data") return fake.backup ? new Response(fake.backup.text, { status: 200, headers: { "content-type": "application/json" } }) : json({ error: { type: "no_backup" } }, 404);
      return new Response("not found", { status: 404 });
    }),
  );
  return fake;
}

async function seedNote(title: string) {
  const { getRepo } = await import("../lib/app");
  const repo = await getRepo();
  await repo.putNote({ id: `local-${title}`, title, sourceKind: "blank", sourceText: "", blocks: [], createdAt: 1, updatedAt: 1, lastOpenedAt: Date.now() });
  return repo;
}

async function renderPage(page: "Dashboard" | "Settings") {
  const { AppProvider } = await import("../lib/app");
  const Page = (await import(page === "Dashboard" ? "../pages/Dashboard" : "../pages/Settings")).default;
  render(
    <MemoryRouter>
      <AppProvider>
        <Page />
      </AppProvider>
    </MemoryRouter>,
  );
}

const backupCalls = (fake: Fake) => fake.calls.filter((c) => c.includes("/api/publik/backup"));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("open", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard — restore card (reinstall / second computer)", () => {
  it("empty library + a backup in the account, setting OFF: the card restores the library", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English" }));
    const fake = stubServer({ backup: true });
    await renderPage("Dashboard");
    const user = userEvent.setup();

    const card = await screen.findByRole("region", { name: "Restore your library" });
    expect(card).toHaveTextContent(/Your library is saved in your publik account \(.*2026.*\)\. Restore it\?/);
    expect(card).toHaveTextContent("Nothing here is overwritten.");
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Cell biology")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Restore your library" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Restored 1 note, 1 flashcard. Nothing on this computer was overwritten.");

    const { getRepo } = await import("../lib/app");
    expect((await (await getRepo()).listNotes()).map((n) => n.title)).toEqual(["Cell biology"]);
    expect((await (await getRepo()).cardsFor("n1"))).toHaveLength(1);
    // A restore sends nothing to the account.
    expect(fake.posts).toHaveLength(0);
  });

  it("\"Not now\" closes the card, downloads nothing, and the card stays closed for that backup", async () => {
    const fake = stubServer({ backup: true });
    await renderPage("Dashboard");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Restore your library" })).not.toBeInTheDocument();
    expect(fake.calls).not.toContain("GET /api/publik/backup/data");
    expect(JSON.parse(localStorage.getItem("nitroai.backup")!)).toMatchObject({ dismissedRestoreId: "file_1" });

    cleanup();
    vi.resetModules();
    await renderPage("Dashboard");
    await waitFor(() => expect(backupCalls(fake).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("region", { name: "Restore your library" })).not.toBeInTheDocument();
  });

  it("a library with notes: no card, and the account is not asked", async () => {
    const fake = stubServer({ backup: true });
    await seedNote("My own note");
    await renderPage("Dashboard");
    expect(await screen.findByText("My own note")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Restore your library" })).not.toBeInTheDocument();
    expect(backupCalls(fake)).toEqual([]);
  });

  it("no backup in the account, or publik is not the person's choice: no card", async () => {
    for (const opts of [{ backup: false }, { backup: true, publik: false }]) {
      const fake = stubServer(opts);
      await renderPage("Dashboard");
      await waitFor(() => expect(backupCalls(fake)).toEqual(["GET /api/publik/backup"]));
      expect(screen.queryByRole("region", { name: "Restore your library" })).not.toBeInTheDocument();
      cleanup();
      vi.resetModules();
    }
  });

  it("a failed restore shows one sentence and keeps the card", async () => {
    const fake = stubServer({ backup: true });
    await renderPage("Dashboard");
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "Restore your library" });
    fake.backup!.text = "{ damaged";
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The backup file is damaged and cannot be read.");
    expect(screen.getByRole("region", { name: "Restore your library" })).toBeInTheDocument();
  });
});

describe("Settings — Library backup", () => {
  const publikPrefs = (extra: Record<string, unknown> = {}) =>
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2, ...extra }));

  it("not on publik API: no backup card; Settings says the notes are on this computer only", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "local", onboarded: true, language: "English" }));
    const fake = stubServer({ backup: true });
    await renderPage("Settings");
    expect(await screen.findByTestId("where-notes-live")).toHaveTextContent("Your notes are stored on this computer only.");
    await waitFor(() => expect(fake.calls).toContain("GET /api/publik/status"));
    expect(screen.queryByTestId("library-backup")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("on publik API: the switch is OFF by default, says what it does and costs; nothing is sent", async () => {
    publikPrefs();
    const fake = stubServer();
    await seedNote("Cells");
    await renderPage("Settings");
    const card = await screen.findByTestId("library-backup");
    const sw = screen.getByRole("switch", { name: "Keep my library in my publik account" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(card).toHaveTextContent("Saves your notes, flashcards, quizzes and chats to your publik account.");
    expect(card).toHaveTextContent("They come back after a reinstall or on another computer.");
    expect(card).toHaveTextContent("Each backup costs about 1 cent from your publik balance.");
    expect(card).toHaveTextContent("At most one automatic backup a day.");
    expect(card).toHaveTextContent("Your notes are stored on this computer only.");
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore from my publik account" })).not.toBeInTheDocument();
    expect(fake.posts).toHaveLength(0);
  });

  it("turning it ON saves the pref and makes the first backup; then \"Last backup\" shows time and size", async () => {
    publikPrefs();
    const fake = stubServer();
    await seedNote("Cells");
    await renderPage("Settings");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Keep my library in my publik account" }));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(localStorage.getItem("nitroai.prefs")!).libraryBackup).toBe(true);

    await waitFor(() => expect(fake.posts).toHaveLength(1));
    expect(JSON.parse(fake.posts[0]).collections.notes[0].title).toBe("Cells");
    const card = screen.getByTestId("library-backup");
    await waitFor(() => expect(card).toHaveTextContent(/Last backup: .*\d{4}.*, \d+ (bytes|KB)/));
    expect(screen.getByTestId("where-notes-live")).toHaveTextContent("Your library is also saved in your publik account.");
    expect(screen.queryByText(/stored on this computer only/)).not.toBeInTheDocument();
    // The account now has a backup: the restore button is there.
    expect(await screen.findByRole("button", { name: "Restore from my publik account" })).toBeInTheDocument();

    // "Back up now" with no change: nothing is sent again.
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your library did not change since the last backup.");
    expect(fake.posts).toHaveLength(1);
  });

  it("\"Back up now\" errors show one plain sentence", async () => {
    publikPrefs({ libraryBackup: true });
    localStorage.setItem("nitroai.backup", JSON.stringify({ lastBackupAt: Date.now(), lastBackupHash: "old", lastBackupBytes: 10 }));
    const fake = stubServer();
    fake.failPost = { status: 413, type: "storage_quota_exceeded" };
    await seedNote("Cells");
    await renderPage("Settings");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your publik storage for NitroAI is full. The backup was not saved.");
    fake.failPost = { status: 402, type: "insufficient_credit" };
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your publik balance is too low. The backup was not saved. Add credit, then try again."));
    expect(fake.posts).toHaveLength(0);
  });

  it("a second computer with its own notes: \"Restore from my publik account\" merges; the local note stays; the backup of the other computer is not replaced first", async () => {
    publikPrefs({ libraryBackup: true });
    const fake = stubServer({ backup: true });
    const repo = await seedNote("Made on this computer");
    await renderPage("Settings");
    const user = userEvent.setup();

    const card = await screen.findByTestId("library-backup");
    const restore = await screen.findByRole("button", { name: "Restore from my publik account" });
    expect(card).toHaveTextContent("Adds what is missing on this computer. Nothing here is overwritten.");
    // The automatic backup did not replace the backup this computer did not make.
    await waitFor(() => expect(card).toHaveTextContent("Your publik account has a backup that this computer did not make. Restore it first."));
    expect(fake.posts).toHaveLength(0);

    await user.click(restore);
    expect(await screen.findByRole("status")).toHaveTextContent("Restored 1 note, 1 flashcard. Nothing on this computer was overwritten.");
    expect((await repo.listNotes()).map((n) => n.title).sort()).toEqual(["Cell biology", "Made on this computer"]);

    // Now a backup keeps the notes of both computers.
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(fake.posts).toHaveLength(1));
    expect(JSON.parse(fake.posts[0]).collections.notes.map((n: { title: string }) => n.title).sort()).toEqual(["Cell biology", "Made on this computer"]);
  });
});
