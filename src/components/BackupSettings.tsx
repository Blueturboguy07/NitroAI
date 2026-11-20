/* "Keep my library in my publik account" in Settings (lib/libraryBackup.ts).

   Shown only when publik API is the engine in use: the backup is paid from
   the publik balance and belongs to the signed-in publik account.
     - the switch (off until the person turns it on) and what it does and costs
     - when on: "Last backup: <time>, <size>" and "Back up now"
     - when the account has a backup: "Restore from my publik account" (merge)
   Every error is one plain sentence. */

import { useEffect, useState } from "react";
import { CloudUpload, Loader2 } from "lucide-react";
import { useApp } from "../lib/app";
import {
  backUpLibrary,
  backupCopy as copy,
  fetchBackupInfo,
  formatBytes,
  formatWhen,
  getBackupState,
  lastBackupLine,
  restoreLibrary,
  restoreSentence,
  subscribeBackupState,
  type BackupInfo,
  type BackupState,
} from "../lib/libraryBackup";
import { dollars } from "../lib/publik";

export default function BackupSettings() {
  const { repo, prefs, savePrefs, bump } = useApp();
  const on = prefs.libraryBackup === true;
  const [state, setState] = useState<BackupState>(() => getBackupState());
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => subscribeBackupState(setState), []);
  useEffect(() => {
    let alive = true;
    void fetchBackupInfo().then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, [state.lastSyncedId]);

  async function backUp() {
    if (!repo || busy) return;
    setBusy("backup");
    setNote(null);
    const r = await backUpLibrary(repo.store);
    setBusy(null);
    if (!r.ok) return setNote({ text: r.message, bad: r.reason !== "empty" });
    if (r.done === "unchanged") return setNote({ text: copy.unchanged, bad: false });
    setNote({
      text: `Backup saved (${formatBytes(r.bytes)}).${r.chargeMicros ? ` It cost ${dollars(r.chargeMicros)}.` : ""}`,
      bad: false,
    });
  }

  async function restore() {
    if (!repo || busy) return;
    setBusy("restore");
    setNote(null);
    const r = await restoreLibrary(repo.store);
    setBusy(null);
    if (!r.ok) return setNote({ text: r.message, bad: true });
    bump();
    setNote({ text: restoreSentence(r.result), bad: false });
  }

  const foreign = !!info?.exists && info.id !== state.lastSyncedId;
  const accountWhen = info?.exists && info.created_at ? formatWhen(Date.parse(info.created_at)) : "";

  return (
    <div className="rounded-card border border-edge bg-card p-6 shadow-soft" data-testid="library-backup">
      <h2 className="flex items-center gap-2 font-display text-xl font-bold">
        <CloudUpload className="size-5 text-accent" />
        Library backup
      </h2>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id="library-backup-label" className="text-sm font-semibold">
            {copy.settingLabel}
          </p>
          <p className="mt-1 text-sm text-ink-faint">{copy.settingBody}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="library-backup-label"
          onClick={() => {
            setNote(null);
            savePrefs({ ...prefs, libraryBackup: !on });
          }}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-accent" : "bg-edge"}`}
        >
          <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow-soft transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
        </button>
      </div>

      {!on && <p className="mt-3 text-xs font-semibold text-ink-dim">{copy.localOnly}</p>}

      {on && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={backUp}
            disabled={!!busy}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {busy === "backup" && <Loader2 className="size-4 animate-spin" />}
            {busy === "backup" ? copy.backingUp : copy.backUpNow}
          </button>
          <span className="text-sm text-ink-faint">{lastBackupLine(state)}</span>
        </div>
      )}

      {on && !note && foreign && <p className="mt-3 text-xs font-semibold text-ink-dim">{copy.otherComputer}</p>}
      {on && !note && !busy && !foreign && state.lastError && (
        <p role="alert" className="mt-3 text-xs font-semibold text-danger-ink">
          {state.lastError}
        </p>
      )}

      {info?.exists && (
        <div className="mt-4 border-t border-edge pt-4">
          <button
            type="button"
            onClick={restore}
            disabled={!!busy}
            className="inline-flex items-center gap-2 rounded-xl border border-edge bg-panel px-4 py-2 text-sm font-semibold shadow-soft hover:bg-card-hover disabled:opacity-60"
          >
            {busy === "restore" && <Loader2 className="size-4 animate-spin" />}
            {busy === "restore" ? copy.restoring : copy.restore}
          </button>
          <p className="mt-2 text-xs text-ink-faint">
            {accountWhen ? `Backup of ${accountWhen}${info.bytes ? `, ${formatBytes(info.bytes)}` : ""}. ` : ""}
            {copy.restoreHint}
          </p>
        </div>
      )}

      {note && (
        <p role={note.bad ? "alert" : "status"} className={`mt-3 text-xs font-semibold ${note.bad ? "text-danger-ink" : "text-ink-dim"}`}>
          {note.text}
        </p>
      )}
    </div>
  );
}
