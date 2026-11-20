/* "Keep my library in my publik account": the renderer side.

   The snapshot (lib/backup.ts) goes to the local server, which owns the
   publik key and talks to publik (server/publikBackup.mjs):
     GET  /api/publik/backup        is there a backup in the account
     POST /api/publik/backup        save this snapshot as the backup
     GET  /api/publik/backup/data   the snapshot of the newest backup

   Rules:
     - An automatic backup runs at most once every 24 hours, and only when
       the library changed since the last backup. Each backup costs money.
     - An empty library is never backed up: it would replace a real backup.
     - A backup that another computer made is never replaced before this
       computer restored it (merge). So two computers cannot erase the notes
       of each other in the account.
     - A restore is a merge: it adds what is missing here and overwrites
       nothing.

   What this computer remembers about its backups is in localStorage, next to
   the prefs. */

import { makeSnapshot, parseSnapshot, restoreSnapshot, snapshotFingerprint, SnapshotError, type RestoreResult } from "./backup";
import { COLLECTIONS, type Store } from "./db";
import { localFetch } from "./localApi";

export const AUTO_BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
/* After a failed automatic backup: the next try is not before this. */
export const AUTO_BACKUP_RETRY_MS = 60 * 60 * 1000;

const KEY = "nitroai.backup";

export interface BackupState {
  /* The last backup this computer made. */
  lastBackupAt?: number;
  lastBackupBytes?: number;
  lastBackupHash?: string;
  /* The account backup this computer made or restored last. */
  lastSyncedId?: string;
  /* The last automatic try that failed, and its sentence. */
  lastFailedAt?: number;
  lastError?: string;
  /* "Not now" on the dashboard card: the backup that was declined. */
  dismissedRestoreId?: string;
}

const listeners = new Set<(s: BackupState) => void>();

export function getBackupState(): BackupState {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as BackupState) : {};
  } catch {
    return {};
  }
}

export function patchBackupState(patch: Partial<BackupState>): BackupState {
  const next = { ...getBackupState(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage is full or off: the state lasts for this run only */
  }
  for (const l of listeners) l(next);
  return next;
}

export function subscribeBackupState(fn: (s: BackupState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---- Words ---------------------------------------------------------------- */

export const backupCopy = {
  settingLabel: "Keep my library in my publik account",
  settingBody:
    "Saves your notes, flashcards, quizzes and chats to your publik account. They come back after a reinstall or on another computer. Each backup costs about 1 cent from your publik balance. At most one automatic backup a day.",
  localOnly: "Your notes are stored on this computer only.",
  localOnlyHint: "If you reinstall NitroAI or change computers, they do not come with you.",
  backedUp: "Your library is also saved in your publik account.",
  backUpNow: "Back up now",
  backingUp: "Backing up…",
  restore: "Restore from my publik account",
  restoring: "Restoring…",
  never: "Last backup: none yet.",
  nothingToBackUp: "There is nothing to back up yet. Add a note first.",
  unchanged: "Your library did not change since the last backup. Nothing was sent and nothing was charged.",
  otherComputer:
    "Your publik account has a backup that this computer did not make. Restore it first. Then a new backup keeps the notes of both.",
  noBackup: "There is no backup in your publik account.",
  restoreHint: "Adds what is missing on this computer. Nothing here is overwritten.",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatWhen(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* "Last backup: Nov 20, 2026, 3:04 PM, 48 KB" */
export function lastBackupLine(s: BackupState): string {
  if (!s.lastBackupAt) return backupCopy.never;
  const size = typeof s.lastBackupBytes === "number" ? `, ${formatBytes(s.lastBackupBytes)}` : "";
  return `Last backup: ${formatWhen(s.lastBackupAt)}${size}`;
}

/* One plain sentence for a failed backup or restore. `status` 0 = the local
   server or the network did not answer. */
export function backupErrorSentence(status: number, type?: string | null, what: "backup" | "restore" = "backup"): string {
  const t = (type ?? "").toLowerCase();
  const tail = what === "backup" ? "The backup was not saved." : "Nothing was restored.";
  if (t === "sign_in_required" || status === 403) return "Sign in to publik to use the library backup.";
  if (t === "storage_quota_exceeded") return `Your publik storage for NitroAI is full. ${tail}`;
  if (t === "backup_too_large" || status === 413) return "Your library is too large to back up.";
  if (/cap|limit/.test(t)) return `You reached your publik spend limit for today. ${tail}`;
  if (status === 402 || /credit|balance|payment/.test(t)) return `Your publik balance is too low. ${tail} Add credit, then try again.`;
  if (t === "no_publik_credential" || t === "key_revoked" || status === 401) return "publik API is not set up on this computer.";
  if (t === "no_backup" || status === 404) return backupCopy.noBackup;
  if (status === 503) return "The library backup is not switched on at publik yet. Try again later.";
  if (status === 0 || t === "gateway_unreachable") return `You are offline, or publik is not reachable. ${tail}`;
  if (t === "upload_failed" || t === "backup_not_ready") return "The backup did not finish. Your earlier backup is still there. Try again.";
  if (t === "download_failed") return "The download did not finish. Try again.";
  return what === "backup" ? "The backup did not work. Try again." : "The restore did not work. Try again.";
}

/* ---- Calls to the local server -------------------------------------------- */

export interface BackupInfo {
  /* False when publik API is not the person's choice on this computer. */
  available: boolean;
  exists: boolean;
  id: string | null;
  bytes: number | null;
  created_at: string | null;
}

class CallError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
  ) {
    super(backupErrorSentence(status, type));
  }
  sentence(what: "backup" | "restore"): string {
    return backupErrorSentence(this.status, this.type, what);
  }
}

async function failure(res: Response): Promise<CallError> {
  let type: string | null = null;
  try {
    const body = (await res.json()) as { error?: { type?: unknown } };
    if (typeof body?.error?.type === "string") type = body.error.type;
  } catch {
    /* no JSON body */
  }
  return new CallError(res.status, type);
}

const isJson = (res: Response) => (res.headers.get("content-type") ?? "").includes("application/json");

/* Throws CallError. A non-JSON answer means there is no local server (plain
   `npm run dev`): the backup is then not available. */
async function readInfo(): Promise<BackupInfo> {
  let res: Response;
  try {
    res = await localFetch("/api/publik/backup", { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new CallError(0, null);
  }
  if (!isJson(res)) return { available: false, exists: false, id: null, bytes: null, created_at: null };
  if (!res.ok) throw await failure(res);
  const b = (await res.json()) as Partial<BackupInfo>;
  return {
    available: b.available === true,
    exists: b.exists === true && typeof b.id === "string",
    id: typeof b.id === "string" ? b.id : null,
    bytes: typeof b.bytes === "number" ? b.bytes : null,
    created_at: typeof b.created_at === "string" ? b.created_at : null,
  };
}

/* Never throws: null when the answer is not known (offline, no server). */
export async function fetchBackupInfo(): Promise<BackupInfo | null> {
  try {
    return await readInfo();
  } catch {
    return null;
  }
}

/* ---- Back up -------------------------------------------------------------- */

export type BackupOutcome =
  | { ok: true; done: "saved"; at: number; bytes: number; chargeMicros: number | null }
  | { ok: true; done: "unchanged" }
  | { ok: false; reason: "empty" | "other_computer" | "error"; message: string };

let running: Promise<BackupOutcome> | null = null;

/* Save the library to the account now. One at a time: a second call while
   one runs gets the same answer. */
export function backUpLibrary(store: Store, opts: { now?: number } = {}): Promise<BackupOutcome> {
  if (!running) {
    running = doBackup(store, opts.now ?? Date.now()).finally(() => {
      running = null;
    });
  }
  return running;
}

async function doBackup(store: Store, now: number): Promise<BackupOutcome> {
  const snapshot = await makeSnapshot(store, now);
  if (snapshot.collections.notes.length === 0) return { ok: false, reason: "empty", message: backupCopy.nothingToBackUp };
  const hash = snapshotFingerprint(snapshot);

  try {
    // A backup this computer did not make and did not restore is not replaced.
    const info = await readInfo();
    const state = getBackupState();
    if (info.exists && info.id !== state.lastSyncedId) {
      return { ok: false, reason: "other_computer", message: backupCopy.otherComputer };
    }
    if (info.exists && hash === state.lastBackupHash) return { ok: true, done: "unchanged" };

    const text = JSON.stringify(snapshot);
    let res: Response;
    try {
      res = await localFetch("/api/publik/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      throw new CallError(0, null);
    }
    if (!isJson(res)) throw new CallError(0, null);
    if (!res.ok) throw await failure(res);
    const saved = (await res.json()) as { id?: string; bytes?: number; charge_micros?: number };
    const bytes = typeof saved.bytes === "number" ? saved.bytes : new Blob([text]).size;
    patchBackupState({
      lastBackupAt: now,
      lastBackupBytes: bytes,
      lastBackupHash: hash,
      lastSyncedId: typeof saved.id === "string" ? saved.id : undefined,
      lastFailedAt: undefined,
      lastError: undefined,
    });
    return { ok: true, done: "saved", at: now, bytes, chargeMicros: typeof saved.charge_micros === "number" ? saved.charge_micros : null };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof CallError ? e.sentence("backup") : backupErrorSentence(-1) };
  }
}

/* Is an automatic backup due? Pure, for tests. */
export function autoBackupDue(state: BackupState, now: number): boolean {
  if (state.lastBackupAt && now - state.lastBackupAt < AUTO_BACKUP_EVERY_MS) return false;
  if (state.lastFailedAt && now - state.lastFailedAt < AUTO_BACKUP_RETRY_MS) return false;
  return true;
}

/* The automatic backup. Call it often (app start, a timer): it does
   something at most once every 24 hours, and only when the library changed.
   Returns null when it did nothing. */
export async function maybeAutoBackup(store: Store, opts: { enabled: boolean; now?: number }): Promise<BackupOutcome | null> {
  const now = opts.now ?? Date.now();
  if (!opts.enabled) return null;
  const state = getBackupState();
  if (!autoBackupDue(state, now)) return null;
  // Cheap checks first: no notes, or no change, means no call at all.
  const snapshot = await makeSnapshot(store, now);
  if (snapshot.collections.notes.length === 0) return null;
  if (state.lastBackupHash && state.lastBackupHash === snapshotFingerprint(snapshot)) return null;
  const outcome = await backUpLibrary(store, { now });
  if (!outcome.ok) patchBackupState({ lastFailedAt: now, lastError: outcome.message });
  return outcome;
}

/* ---- Restore -------------------------------------------------------------- */

export type RestoreOutcome = { ok: true; result: RestoreResult; id: string | null } | { ok: false; message: string };

/* Download the newest backup and merge it into the local library. */
export async function restoreLibrary(store: Store): Promise<RestoreOutcome> {
  try {
    const info = await readInfo();
    if (!info.exists) return { ok: false, message: backupCopy.noBackup };
    let res: Response;
    try {
      res = await localFetch("/api/publik/backup/data", { signal: AbortSignal.timeout(15 * 60_000) });
    } catch {
      throw new CallError(0, null);
    }
    if (!res.ok) throw await failure(res);
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new CallError(502, "download_failed");
    }
    const snapshot = parseSnapshot(text);
    const before = await makeSnapshot(store);
    const wasEmpty = Object.values(before.collections).every((rows) => rows.length === 0);
    const result = await restoreSnapshot(store, snapshot, { mode: "merge" });
    patchBackupState({
      // This computer now holds that backup: a later backup may replace it.
      lastSyncedId: info.id ?? undefined,
      dismissedRestoreId: undefined,
      lastFailedAt: undefined,
      lastError: undefined,
      // An empty library that took the whole backup is equal to the account:
      // no new backup until something changes.
      ...(wasEmpty ? { lastBackupHash: snapshotFingerprint(await makeSnapshot(store)) } : {}),
    });
    return { ok: true, result, id: info.id };
  } catch (e) {
    if (e instanceof SnapshotError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof CallError ? e.sentence("restore") : backupErrorSentence(-1, null, "restore") };
  }
}

/* "Added 12 notes, 40 flashcards." */
export function restoreSentence(result: RestoreResult): string {
  if (result.addedTotal === 0) return "Everything in the backup is already on this computer. Nothing changed.";
  const parts: string[] = [];
  const say = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  say(result.added.notes, "note", "notes");
  say(result.added.folders, "folder", "folders");
  say(result.added.flashcards, "flashcard", "flashcards");
  say(result.added.quiz, "quiz question", "quiz questions");
  say(result.added.chat, "chat message", "chat messages");
  say(result.added.podcasts, "podcast script", "podcast scripts");
  const what = parts.length ? parts.join(", ") : `${result.addedTotal} saved items`;
  return `Restored ${what}. Nothing on this computer was overwritten.`;
}

/* How many notes the local library has. */
export async function localNoteCount(store: Store): Promise<number> {
  return (await store.all(COLLECTIONS.notes)).length;
}
