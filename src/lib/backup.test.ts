/* The library snapshot (lib/backup.ts) with the in-memory store. */
import { describe, expect, it } from "vitest";
import { COLLECTIONS, type Store } from "./db";
import { memoryStore } from "./db/memory";
import { makeSnapshot, parseSnapshot, restoreSnapshot, snapshotFingerprint, SnapshotError, SNAPSHOT_COLLECTIONS } from "./backup";

const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);

async function library(): Promise<Store> {
  const s = memoryStore();
  await s.put(COLLECTIONS.folders, { id: "f1", name: "Biology", createdAt: 1 });
  await s.put(COLLECTIONS.notes, { id: "n2", title: "Genes", sourceKind: "blank", sourceText: "", blocks: [], folderId: "f1", createdAt: 2, updatedAt: 2, lastOpenedAt: 2 });
  await s.put(COLLECTIONS.notes, { id: "n1", title: "Cells", sourceKind: "pdf", sourceText: "A cell…", blocks: [{ id: "b1", type: "paragraph", text: "Cells" }], createdAt: 1, updatedAt: 1, lastOpenedAt: 1 });
  await s.put(COLLECTIONS.flashcards, { id: "c1", noteId: "n1", front: "Q", back: "A", topic: "t", due: 5, stability: 1, difficulty: 1, reps: 3, lapses: 0, state: "review" });
  await s.put(COLLECTIONS.quiz, { id: "q1", noteId: "n1", type: "mcq", topic: "t" });
  await s.put(COLLECTIONS.attempts, { id: "a1", noteId: "n1", questionId: "q1", correct: true, at: 3 });
  await s.put(COLLECTIONS.chat, { id: "t1", noteId: "n1", role: "user", content: "What is a cell?", at: 4 });
  await s.put(COLLECTIONS.podcasts, { id: "p1", noteId: "n1", length: "short", script: [{ speaker: "host", text: "Hi", spoken: "Hi" }], audioUrl: "blob:http://127.0.0.1:41763/7f3c", createdAt: 5 });
  await s.put(COLLECTIONS.podcasts, { id: "p2", noteId: "n1", length: "short", script: [], audioUrl: "data:audio/mpeg;base64,AAAA", createdAt: 6 });
  await s.put(COLLECTIONS.podcasts, { id: "p3", noteId: "n1", length: "long", script: [], audioUrl: "/Users/me/podcast.mp3", createdAt: 7 });
  await s.put(COLLECTIONS.jobs, { id: "j1", status: "running", message: "Working" });
  return s;
}

describe("makeSnapshot", () => {
  it("has the format, the version, the time and the seven collections; jobs are left out", async () => {
    const snap = await makeSnapshot(await library(), NOW);
    expect(snap.format).toBe("nitroai-library");
    expect(snap.version).toBe(1);
    expect(snap.madeAt).toBe("2026-11-20T10:00:00.000Z");
    expect(Object.keys(snap.collections).sort()).toEqual(["attempts", "chat", "flashcards", "folders", "notes", "podcasts", "quiz"]);
    expect(JSON.stringify(snap)).not.toContain("Working");
    expect(snap.collections.notes.map((n) => n.id)).toEqual(["n1", "n2"]); // sorted by id
    expect(snap.collections.notes[0]).toMatchObject({ title: "Cells", sourceText: "A cell…", blocks: [{ id: "b1", type: "paragraph", text: "Cells" }] });
    expect(snap.collections.flashcards[0]).toMatchObject({ reps: 3, state: "review" }); // the study state travels
  });

  it("drops a podcast audioUrl that is a blob: or data: URL, keeps the script and the rest", async () => {
    const snap = await makeSnapshot(await library(), NOW);
    const [p1, p2, p3] = snap.collections.podcasts;
    expect(p1).toEqual({ id: "p1", noteId: "n1", length: "short", script: [{ speaker: "host", text: "Hi", spoken: "Hi" }], createdAt: 5 });
    expect("audioUrl" in p2).toBe(false);
    expect(p3.audioUrl).toBe("/Users/me/podcast.mp3");
    expect(JSON.stringify(snap)).not.toMatch(/blob:|data:audio/);
  });

  it("an empty store gives seven empty collections", async () => {
    const snap = await makeSnapshot(memoryStore(), NOW);
    for (const name of SNAPSHOT_COLLECTIONS) expect(snap.collections[name]).toEqual([]);
  });
});

describe("parseSnapshot", () => {
  it("round trip: the text of a snapshot parses to the same snapshot", async () => {
    const snap = await makeSnapshot(await library(), NOW);
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
  });

  it("refuses text that is not JSON, not an object, another format, a bad version or bad collections", () => {
    const ok = { format: "nitroai-library", version: 1, madeAt: "x", collections: {} };
    for (const text of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...ok, format: "something-else" }),
      JSON.stringify({ ...ok, version: "1" }),
      JSON.stringify({ ...ok, version: 0 }),
      JSON.stringify({ ...ok, collections: [] }),
      JSON.stringify({ ...ok, collections: undefined }),
      JSON.stringify({ ...ok, collections: { notes: { id: "n1" } } }),
    ]) {
      expect(() => parseSnapshot(text), text).toThrow(SnapshotError);
    }
  });

  it("a snapshot of a newer version says: update NitroAI", () => {
    expect(() => parseSnapshot(JSON.stringify({ format: "nitroai-library", version: 2, collections: {} }))).toThrow("A newer NitroAI made this backup. Update NitroAI, then restore.");
  });

  it("a missing collection is empty; a row with no id, and an unknown collection, are dropped; audio URLs are cleaned", () => {
    const snap = parseSnapshot(
      JSON.stringify({
        format: "nitroai-library",
        version: 1,
        madeAt: "2026-11-20T10:00:00.000Z",
        collections: {
          notes: [{ id: "n1", title: "Cells" }, { title: "no id" }, null, "text", { id: 7 }],
          podcasts: [{ id: "p1", audioUrl: "blob:x", script: [] }],
          jobs: [{ id: "j1" }],
        },
      }),
    );
    expect(snap.collections.notes).toEqual([{ id: "n1", title: "Cells" }]);
    expect(snap.collections.podcasts).toEqual([{ id: "p1", script: [] }]);
    expect(snap.collections.chat).toEqual([]);
    expect("jobs" in snap.collections).toBe(false);
  });
});

describe("restoreSnapshot (merge)", () => {
  it("into an empty store: every row comes back, and the counts say so", async () => {
    const snap = await makeSnapshot(await library(), NOW);
    const target = memoryStore();
    const r = await restoreSnapshot(target, parseSnapshot(JSON.stringify(snap)), { mode: "merge" });
    expect(r.added).toEqual({ notes: 2, folders: 1, flashcards: 1, quiz: 1, attempts: 1, chat: 1, podcasts: 3 });
    expect(r.addedTotal).toBe(10);
    expect(r.skippedTotal).toBe(0);
    expect((await makeSnapshot(target, NOW)).collections).toEqual(snap.collections);
    expect(await target.all(COLLECTIONS.jobs)).toEqual([]);
  });

  it("never overwrites a local row: the same id keeps the local value, new ids are added, local-only rows stay", async () => {
    const snap = await makeSnapshot(await library(), NOW);
    const target = memoryStore();
    await target.put(COLLECTIONS.notes, { id: "n1", title: "Cells (edited on this computer)", blocks: [] });
    await target.put(COLLECTIONS.notes, { id: "n-local", title: "Only here" });
    await target.put(COLLECTIONS.chat, { id: "t1", noteId: "n1", role: "user", content: "local chat", at: 9 });

    const r = await restoreSnapshot(target, snap, { mode: "merge" });
    expect(r.added.notes).toBe(1);
    expect(r.skipped.notes).toBe(1);
    expect(r.skipped.chat).toBe(1);
    expect(r.skippedTotal).toBe(2);

    expect(await target.get(COLLECTIONS.notes, "n1")).toEqual({ id: "n1", title: "Cells (edited on this computer)", blocks: [] });
    expect(await target.get(COLLECTIONS.notes, "n-local")).toEqual({ id: "n-local", title: "Only here" });
    expect(await target.get(COLLECTIONS.notes, "n2")).toMatchObject({ title: "Genes", folderId: "f1" });
    expect(await target.get(COLLECTIONS.chat, "t1")).toMatchObject({ content: "local chat" });
  });

  it("a second restore of the same snapshot adds nothing", async () => {
    const snap = await makeSnapshot(await library(), NOW);
    const target = memoryStore();
    await restoreSnapshot(target, snap, { mode: "merge" });
    const again = await restoreSnapshot(target, snap, { mode: "merge" });
    expect(again.addedTotal).toBe(0);
    expect(again.skippedTotal).toBe(10);
  });

  it("the same id twice in one snapshot is put once", async () => {
    const target = memoryStore();
    const snap = parseSnapshot(JSON.stringify({ format: "nitroai-library", version: 1, collections: { notes: [{ id: "n1", title: "first" }, { id: "n1", title: "second" }] } }));
    const r = await restoreSnapshot(target, snap, { mode: "merge" });
    expect(r.added.notes).toBe(1);
    expect(await target.get(COLLECTIONS.notes, "n1")).toMatchObject({ title: "first" });
  });
});

describe("snapshotFingerprint", () => {
  it("is the same for the same library at another time, and after a note was only opened", async () => {
    const s = await library();
    const a = snapshotFingerprint(await makeSnapshot(s, NOW));
    const n1 = (await s.get<{ id: string; lastOpenedAt: number }>(COLLECTIONS.notes, "n1"))!;
    await s.put(COLLECTIONS.notes, { ...n1, lastOpenedAt: NOW + 5000 });
    expect(snapshotFingerprint(await makeSnapshot(s, NOW + 86_400_000))).toBe(a);
  });

  it("changes when a note, a card or a chat changes", async () => {
    const s = await library();
    const a = snapshotFingerprint(await makeSnapshot(s, NOW));
    await s.put(COLLECTIONS.chat, { id: "t2", noteId: "n1", role: "assistant", content: "A cell is…", at: 5 });
    const b = snapshotFingerprint(await makeSnapshot(s, NOW));
    expect(b).not.toBe(a);
    const n1 = (await s.get<{ id: string; title: string }>(COLLECTIONS.notes, "n1"))!;
    await s.put(COLLECTIONS.notes, { ...n1, title: "Cellz" });
    expect(snapshotFingerprint(await makeSnapshot(s, NOW))).not.toBe(b);
  });
});
