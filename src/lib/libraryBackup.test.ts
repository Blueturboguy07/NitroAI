/* The renderer side of the library backup (lib/libraryBackup.ts) against a
   FAKE local server: an in-memory /api/publik/backup that keeps one backup.
   No network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTIONS, type Store } from "./db";
import { memoryStore } from "./db/memory";
import {
  AUTO_BACKUP_EVERY_MS,
  AUTO_BACKUP_RETRY_MS,
  autoBackupDue,
  backUpLibrary,
  backupCopy,
  backupErrorSentence,
  fetchBackupInfo,
  formatBytes,
  getBackupState,
  lastBackupLine,
  maybeAutoBackup,
  patchBackupState,
  restoreLibrary,
  restoreSentence,
} from "./libraryBackup";

const T0 = Date.UTC(2026, 10, 20, 10, 0, 0);
const HOUR = 60 * 60 * 1000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* The local server's backup routes. `fail` makes the next POST answer an error. */
function fakeServer() {
  const s = {
    available: true,
    backup: null as { id: string; text: string; created_at: string } | null,
    posts: [] as string[],
    calls: [] as string[],
    seq: 0,
    fail: null as { status: number; type: string } | null,
    offline: false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      s.calls.push(`${method} ${url}`);
      if (s.offline) throw new TypeError("fetch failed");
      if (new Headers(init.headers).get("x-nitroai-app") !== "1") return json({ error: "forbidden" }, 403);
      if (url === "/api/publik/backup" && method === "GET") {
        if (!s.available) return json({ available: false, exists: false, id: null, bytes: null, created_at: null });
        return json(s.backup ? { available: true, exists: true, id: s.backup.id, bytes: s.backup.text.length, created_at: s.backup.created_at } : { available: true, exists: false, id: null, bytes: null, created_at: null });
      }
      if (url === "/api/publik/backup" && method === "POST") {
        if (s.fail) return json({ error: { type: s.fail.type, message: "upstream words" } }, s.fail.status);
        const text = String(init.body);
        s.posts.push(text);
        s.backup = { id: `file_${++s.seq}`, text, created_at: new Date(T0 + s.seq * 1000).toISOString() };
        return json({ id: s.backup.id, bytes: text.length, created_at: s.backup.created_at, charge_micros: 13000 });
      }
      if (url === "/api/publik/backup/data" && method === "GET") {
        if (!s.backup) return json({ error: { type: "no_backup", message: "none" } }, 404);
        return new Response(s.backup.text, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return s;
}

function fakeLocalStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  });
}

async function storeWith(...titles: string[]): Promise<Store> {
  const s = memoryStore();
  for (const [i, title] of titles.entries()) {
    await s.put(COLLECTIONS.notes, { id: `n${i + 1}`, title, blocks: [], createdAt: 1, updatedAt: 1, lastOpenedAt: 1 });
  }
  return s;
}

beforeEach(() => fakeLocalStorage());
afterEach(() => vi.unstubAllGlobals());

describe("backUpLibrary (Back up now)", () => {
  it("sends the snapshot as JSON with the app header and remembers time, size, hash and id", async () => {
    const server = fakeServer();
    const store = await storeWith("Cells");
    const r = await backUpLibrary(store, { now: T0 });
    expect(r).toMatchObject({ ok: true, done: "saved", at: T0, chargeMicros: 13000 });
    expect(server.posts).toHaveLength(1);
    expect(JSON.parse(server.posts[0])).toMatchObject({ format: "nitroai-library", version: 1, collections: { notes: [{ id: "n1", title: "Cells" }] } });
    const state = getBackupState();
    expect(state).toMatchObject({ lastBackupAt: T0, lastBackupBytes: server.posts[0].length, lastSyncedId: "file_1" });
    expect(state.lastBackupHash).toMatch(/^[0-9a-f]{8}-\d+$/);
    expect(lastBackupLine(state)).toContain("Last backup: ");
    expect(lastBackupLine(state)).toContain(formatBytes(server.posts[0].length));
  });

  it("an empty library is never sent: it would replace a real backup", async () => {
    const server = fakeServer();
    const r = await backUpLibrary(memoryStore(), { now: T0 });
    expect(r).toEqual({ ok: false, reason: "empty", message: backupCopy.nothingToBackUp });
    expect(server.calls).toEqual([]);
  });

  it("no change since the last backup: nothing is sent", async () => {
    const server = fakeServer();
    const store = await storeWith("Cells");
    await backUpLibrary(store, { now: T0 });
    expect(await backUpLibrary(store, { now: T0 + HOUR })).toEqual({ ok: true, done: "unchanged" });
    expect(server.posts).toHaveLength(1);
  });

  it("a backup that this computer did not make is not replaced before a restore", async () => {
    const server = fakeServer();
    // Another computer made the backup in the account.
    const other = await storeWith("From the other computer");
    await backUpLibrary(other, { now: T0 });
    localStorage.clear(); // this computer knows nothing about it

    const mine = memoryStore();
    await mine.put(COLLECTIONS.notes, { id: "mine", title: "Made here", blocks: [] });
    const refused = await backUpLibrary(mine, { now: T0 + HOUR });
    expect(refused).toEqual({ ok: false, reason: "other_computer", message: backupCopy.otherComputer });
    expect(server.posts).toHaveLength(1);

    // After the restore (merge) the backup holds the notes of both.
    const restored = await restoreLibrary(mine);
    expect(restored.ok && restored.result.added.notes).toBe(1);
    expect(await backUpLibrary(mine, { now: T0 + 2 * HOUR })).toMatchObject({ ok: true, done: "saved" });
    const titles = JSON.parse(server.posts[1]).collections.notes.map((n: { title: string }) => n.title).sort();
    expect(titles).toEqual(["From the other computer", "Made here"]);
  });

  it("errors become one plain sentence", async () => {
    const server = fakeServer();
    const store = await storeWith("Cells");
    const cases: [number, string, string][] = [
      [402, "insufficient_credit", "Your publik balance is too low. The backup was not saved. Add credit, then try again."],
      [402, "daily_cap_reached", "You reached your publik spend limit for today. The backup was not saved."],
      [413, "storage_quota_exceeded", "Your publik storage for NitroAI is full. The backup was not saved."],
      [403, "sign_in_required", "Sign in to publik to use the library backup."],
      [503, "files_disabled", "The library backup is not switched on at publik yet. Try again later."],
      [502, "gateway_unreachable", "You are offline, or publik is not reachable. The backup was not saved."],
      [502, "upload_failed", "The backup did not finish. Your earlier backup is still there. Try again."],
    ];
    for (const [status, type, sentence] of cases) {
      server.fail = { status, type };
      const r = await backUpLibrary(store, { now: T0 });
      expect(r, type).toEqual({ ok: false, reason: "error", message: sentence });
      expect(sentence).not.toContain("upstream words");
    }
    server.fail = null;
    server.offline = true;
    expect(await backUpLibrary(store, { now: T0 })).toEqual({ ok: false, reason: "error", message: "You are offline, or publik is not reachable. The backup was not saved." });
    expect(getBackupState().lastBackupAt).toBeUndefined();
  });

  it("backupErrorSentence: every sentence is short and plain", () => {
    for (const [status, type] of [[402, "x"], [413, "storage_quota_exceeded"], [403, null], [401, null], [503, null], [0, null], [500, "weird"]] as [number, string | null][]) {
      const s = backupErrorSentence(status, type);
      expect(s.length).toBeLessThan(110);
      expect(s).toMatch(/\.$/);
    }
    expect(backupErrorSentence(0, null, "restore")).toBe("You are offline, or publik is not reachable. Nothing was restored.");
  });
});

describe("maybeAutoBackup (at most one automatic backup a day, only after a change)", () => {
  it("autoBackupDue: 24 hours after a backup, 1 hour after a failed try", () => {
    expect(autoBackupDue({}, T0)).toBe(true);
    expect(autoBackupDue({ lastBackupAt: T0 }, T0 + AUTO_BACKUP_EVERY_MS - 1)).toBe(false);
    expect(autoBackupDue({ lastBackupAt: T0 }, T0 + AUTO_BACKUP_EVERY_MS)).toBe(true);
    expect(autoBackupDue({ lastFailedAt: T0 }, T0 + AUTO_BACKUP_RETRY_MS - 1)).toBe(false);
    expect(autoBackupDue({ lastFailedAt: T0 }, T0 + AUTO_BACKUP_RETRY_MS)).toBe(true);
  });

  it("the setting is off: nothing runs", async () => {
    const server = fakeServer();
    expect(await maybeAutoBackup(await storeWith("Cells"), { enabled: false, now: T0 })).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("backs up once, then not again for 24 hours even when the library changes, then again", async () => {
    const server = fakeServer();
    const store = await storeWith("Cells");
    expect(await maybeAutoBackup(store, { enabled: true, now: T0 })).toMatchObject({ ok: true, done: "saved" });
    await store.put(COLLECTIONS.notes, { id: "n2", title: "Genes", blocks: [] });
    for (const h of [1, 6, 12, 23]) expect(await maybeAutoBackup(store, { enabled: true, now: T0 + h * HOUR })).toBeNull();
    expect(server.posts).toHaveLength(1);
    expect(await maybeAutoBackup(store, { enabled: true, now: T0 + 24 * HOUR })).toMatchObject({ ok: true, done: "saved" });
    expect(server.posts).toHaveLength(2);
  });

  it("no change after 24 hours: no call at all, so no charge", async () => {
    const server = fakeServer();
    const store = await storeWith("Cells");
    await maybeAutoBackup(store, { enabled: true, now: T0 });
    const before = server.calls.length;
    // Only opened, not changed.
    await store.put(COLLECTIONS.notes, { id: "n1", title: "Cells", blocks: [], createdAt: 1, updatedAt: 1, lastOpenedAt: T0 + 5 });
    expect(await maybeAutoBackup(store, { enabled: true, now: T0 + 48 * HOUR })).toBeNull();
    expect(server.calls).toHaveLength(before);
  });

  it("an empty library is never backed up automatically", async () => {
    const server = fakeServer();
    expect(await maybeAutoBackup(memoryStore(), { enabled: true, now: T0 })).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("a failed try is remembered with its sentence, and the next try waits one hour", async () => {
    const server = fakeServer();
    const store = await storeWith("Cells");
    server.fail = { status: 402, type: "insufficient_credit" };
    expect(await maybeAutoBackup(store, { enabled: true, now: T0 })).toMatchObject({ ok: false, reason: "error" });
    expect(getBackupState()).toMatchObject({ lastFailedAt: T0, lastError: "Your publik balance is too low. The backup was not saved. Add credit, then try again." });
    const calls = server.calls.length;
    expect(await maybeAutoBackup(store, { enabled: true, now: T0 + HOUR - 1 })).toBeNull();
    expect(server.calls).toHaveLength(calls);
    server.fail = null;
    expect(await maybeAutoBackup(store, { enabled: true, now: T0 + HOUR })).toMatchObject({ ok: true, done: "saved" });
    expect(getBackupState().lastError).toBeUndefined();
  });
});

describe("restoreLibrary (merge)", () => {
  it("a reinstall: the empty library gets everything back, and no new backup is due", async () => {
    const server = fakeServer();
    await backUpLibrary(await storeWith("Cells", "Genes"), { now: T0 });
    localStorage.clear(); // the reinstall

    const fresh = memoryStore();
    expect(await fetchBackupInfo()).toMatchObject({ available: true, exists: true, id: "file_1" });
    const r = await restoreLibrary(fresh);
    expect(r.ok && r.result.added.notes).toBe(2);
    expect((await fresh.all<{ title: string }>(COLLECTIONS.notes)).map((n) => n.title).sort()).toEqual(["Cells", "Genes"]);
    expect(r.ok && restoreSentence(r.result)).toBe("Restored 2 notes. Nothing on this computer was overwritten.");
    expect(getBackupState().lastSyncedId).toBe("file_1");
    // The setting is turned on later: the library equals the account, nothing is sent.
    expect(await maybeAutoBackup(fresh, { enabled: true, now: T0 + HOUR })).toBeNull();
    expect(server.posts).toHaveLength(1);
  });

  it("a second computer with its own notes: local rows are not overwritten", async () => {
    fakeServer();
    await backUpLibrary(await storeWith("Cells (account)"), { now: T0 });
    localStorage.clear();
    const mine = memoryStore();
    await mine.put(COLLECTIONS.notes, { id: "n1", title: "Cells (this computer)", blocks: [] });
    const r = await restoreLibrary(mine);
    expect(r.ok && r.result.addedTotal).toBe(0);
    expect(await mine.get(COLLECTIONS.notes, "n1")).toMatchObject({ title: "Cells (this computer)" });
    expect(r.ok && restoreSentence(r.result)).toBe("Everything in the backup is already on this computer. Nothing changed.");
  });

  it("no backup, a damaged backup, offline: one plain sentence, the library does not change", async () => {
    const server = fakeServer();
    const store = await storeWith("Cells");
    expect(await restoreLibrary(store)).toEqual({ ok: false, message: backupCopy.noBackup });
    server.backup = { id: "file_9", text: "{ damaged", created_at: new Date(T0).toISOString() };
    expect(await restoreLibrary(store)).toEqual({ ok: false, message: "The backup file is damaged and cannot be read." });
    server.offline = true;
    expect(await restoreLibrary(store)).toEqual({ ok: false, message: "You are offline, or publik is not reachable. Nothing was restored." });
    expect(await store.all(COLLECTIONS.notes)).toHaveLength(1);
    expect(getBackupState().lastSyncedId).toBeUndefined();
  });

  it("fetchBackupInfo never throws: null when offline, not available with no local server", async () => {
    const server = fakeServer();
    server.offline = true;
    expect(await fetchBackupInfo()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    expect(await fetchBackupInfo()).toEqual({ available: false, exists: false, id: null, bytes: null, created_at: null });
  });

  it("the state survives a damaged localStorage value", () => {
    localStorage.setItem("nitroai.backup", "{ not json");
    expect(getBackupState()).toEqual({});
    expect(patchBackupState({ dismissedRestoreId: "file_1" })).toEqual({ dismissedRestoreId: "file_1" });
  });
});
