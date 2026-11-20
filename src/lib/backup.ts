/* The library snapshot: one JSON document with every collection a person
   would miss after a reinstall. Pure functions over a Store (no DOM, no
   fetch), so the same code runs in the app and in tests with memoryStore().

   The snapshot goes to the person's publik account through the local server
   (lib/libraryBackup.ts, server/publikBackup.mjs). */

import { COLLECTIONS, type Store } from "./db";

export const SNAPSHOT_FORMAT = "nitroai-library";
export const SNAPSHOT_VERSION = 1;

/* `jobs` is left out: a job is the progress of one generation run on this
   computer and means nothing on another one. */
export const SNAPSHOT_COLLECTIONS = ["notes", "folders", "flashcards", "quiz", "attempts", "chat", "podcasts"] as const;
export type SnapshotCollection = (typeof SNAPSHOT_COLLECTIONS)[number];

export type SnapshotRow = { id: string } & Record<string, unknown>;

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  /* ISO time the snapshot was made. */
  madeAt: string;
  collections: Record<SnapshotCollection, SnapshotRow[]>;
}

export type SnapshotCounts = Record<SnapshotCollection, number>;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

function emptyCounts(): SnapshotCounts {
  return { notes: 0, folders: 0, flashcards: 0, quiz: 0, attempts: 0, chat: 0, podcasts: 0 };
}

/* A podcast keeps its script. Its audio does not travel: an object URL
   (blob:) dies with the page that made it, and a data: URL holds the whole
   audio file. A file path or an http(s) link is kept. */
function portableRow(collection: SnapshotCollection, row: SnapshotRow): SnapshotRow {
  if (collection !== "podcasts") return row;
  const url = row.audioUrl;
  if (typeof url === "string" && /^(blob|data):/i.test(url.trim())) {
    const { audioUrl: _dropped, ...rest } = row;
    return rest as SnapshotRow;
  }
  return row;
}

function isRow(v: unknown): v is SnapshotRow {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { id?: unknown }).id === "string" && (v as { id: string }).id !== "";
}

export async function makeSnapshot(store: Store, now: number = Date.now()): Promise<Snapshot> {
  const collections = {} as Record<SnapshotCollection, SnapshotRow[]>;
  for (const name of SNAPSHOT_COLLECTIONS) {
    const rows = await store.all<SnapshotRow>(COLLECTIONS[name]);
    collections[name] = rows
      .filter(isRow)
      .map((r) => portableRow(name, r))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, madeAt: new Date(now).toISOString(), collections };
}

/* Text → Snapshot. Throws SnapshotError with one plain sentence. A row with
   no id is dropped; a missing collection is empty. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError("The backup file is damaged and cannot be read.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SnapshotError("The backup file is damaged and cannot be read.");
  const o = raw as Record<string, unknown>;
  if (o.format !== SNAPSHOT_FORMAT) throw new SnapshotError("This file is not a NitroAI library backup.");
  if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1) {
    throw new SnapshotError("The backup file is damaged and cannot be read.");
  }
  if (o.version > SNAPSHOT_VERSION) throw new SnapshotError("A newer NitroAI made this backup. Update NitroAI, then restore.");
  const cols = o.collections;
  if (!cols || typeof cols !== "object" || Array.isArray(cols)) throw new SnapshotError("The backup file is damaged and cannot be read.");
  const collections = {} as Record<SnapshotCollection, SnapshotRow[]>;
  for (const name of SNAPSHOT_COLLECTIONS) {
    const rows = (cols as Record<string, unknown>)[name];
    if (rows === undefined) {
      collections[name] = [];
      continue;
    }
    if (!Array.isArray(rows)) throw new SnapshotError("The backup file is damaged and cannot be read.");
    collections[name] = rows.filter(isRow).map((r) => portableRow(name, r));
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: o.version,
    madeAt: typeof o.madeAt === "string" ? o.madeAt : "",
    collections,
  };
}

export function countRows(snapshot: Snapshot): SnapshotCounts {
  const counts = emptyCounts();
  for (const name of SNAPSHOT_COLLECTIONS) counts[name] = snapshot.collections[name].length;
  return counts;
}

export interface RestoreResult {
  /* Rows put in the local store, per collection. */
  added: SnapshotCounts;
  /* Rows left out because the local store already has that id. */
  skipped: SnapshotCounts;
  addedTotal: number;
  skippedTotal: number;
}

/* mode "merge": put only the rows whose id is not in the local store. A
   local row is never overwritten and never deleted. */
export async function restoreSnapshot(store: Store, snapshot: Snapshot, opts: { mode: "merge" } = { mode: "merge" }): Promise<RestoreResult> {
  if (opts.mode !== "merge") throw new SnapshotError("Only a merge restore exists.");
  const added = emptyCounts();
  const skipped = emptyCounts();
  for (const name of SNAPSHOT_COLLECTIONS) {
    const have = new Set((await store.all<{ id: string }>(COLLECTIONS[name])).map((r) => r.id));
    for (const row of snapshot.collections[name] ?? []) {
      if (!isRow(row)) continue;
      if (have.has(row.id)) {
        skipped[name] += 1;
        continue;
      }
      await store.put(COLLECTIONS[name], portableRow(name, row));
      have.add(row.id);
      added[name] += 1;
    }
  }
  const sum = (c: SnapshotCounts) => SNAPSHOT_COLLECTIONS.reduce((n, k) => n + c[k], 0);
  return { added, skipped, addedTotal: sum(added), skippedTotal: sum(skipped) };
}

/* A cheap fingerprint of the library content (FNV-1a, 32 bits, plus the
   length). Two snapshots of the same library give the same value: `madeAt`
   is not part of it, and neither is a note's `lastOpenedAt`, so reading a
   note is not a change that needs a new backup. */
export function snapshotFingerprint(snapshot: Snapshot): string {
  const text = JSON.stringify(snapshot.collections, (key, value) => (key === "lastOpenedAt" ? undefined : value));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}
