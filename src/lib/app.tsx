/* App-wide context: opens the local database once, builds the active engine from
   prefs + stored key, and exposes both to every page. A `version` counter lets
   pages cheaply refresh their data after writes.

   The context object and hook live in ./appContext, the database/engine
   plumbing in ./appServices; both are re-exported here so existing
   `import { useApp } from "../lib/app"` call sites keep working. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { Repo } from "./db";
import type { Engine } from "./engine/types";
import { getEnginePrefs, saveEnginePrefs } from "./prefs";
import type { EnginePrefs } from "./types";
import { reconcileJobs } from "./generation/pipeline";
import { AppContext, useApp, type AppCtx, type StorageKind } from "./appContext";
import { buildEngine, getRepo, repoStorageKind } from "./appServices";

export { getRepo, buildEngine, repoStorageKind } from "./appServices";
export { useApp, AppContext, type AppCtx, type StorageKind } from "./appContext";

function engineErrorMessage(e: unknown): string {
  const detail = e instanceof Error && e.message ? ` (${e.message})` : "";
  return `Couldn't start the AI engine${detail}. Check your engine in Settings and try again.`;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [prefs, setPrefs] = useState<EnginePrefs>(() => getEnginePrefs());
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [storage, setStorage] = useState<StorageKind>("indexeddb");
  const [engineError, setEngineError] = useState<string | null>(null);

  /* Every engine build takes a ticket; only the latest ticket may land, so a
     fast toggle (local → cloud → local) can't be overwritten by an older,
     slower build resolving last. */
  const engineSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const applyEngine = useCallback(async (p?: EnginePrefs) => {
    const seq = ++engineSeq.current;
    setEngineError(null);
    try {
      const e = await buildEngine(p);
      if (!alive.current || seq !== engineSeq.current) return;
      setEngine(e);
    } catch (err) {
      if (!alive.current || seq !== engineSeq.current) return;
      setEngine(null);
      setEngineError(engineErrorMessage(err));
    }
  }, []);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const clearEngineError = useCallback(() => setEngineError(null), []);

  const reloadEngine = useCallback(() => {
    const p = getEnginePrefs();
    setPrefs(p);
    void applyEngine(p);
  }, [applyEngine]);

  const savePrefs = useCallback(
    (p: EnginePrefs) => {
      saveEnginePrefs(p);
      setPrefs(p);
      void applyEngine(p);
    },
    [applyEngine],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      const r = await getRepo();
      await reconcileJobs(r).catch(() => {});
      if (!live) return;
      setRepo(r);
      setStorage(repoStorageKind());
      await applyEngine();
      if (!live) return;
      setReady(true);
    })();
    return () => {
      live = false;
    };
  }, [applyEngine]);

  const value = useMemo<AppCtx>(
    () => ({
      repo,
      engine,
      prefs,
      ready,
      version,
      bump,
      reloadEngine,
      savePrefs,
      storage,
      engineError,
      clearEngineError,
    }),
    [repo, engine, prefs, ready, version, bump, reloadEngine, savePrefs, storage, engineError, clearEngineError],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <AppNotices />
    </AppContext.Provider>
  );
}

/* App-level notices, pinned to the bottom of the window so they show on
   every route (including the editor, which sits outside AppShell) without
   shifting any page's layout. */
function AppNotices() {
  const { storage, engineError, clearEngineError } = useApp();
  if (storage !== "memory" && !engineError) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-3">
      {storage === "memory" && (
        <div
          role="status"
          className="pointer-events-auto flex max-w-3xl items-start gap-2.5 rounded-xl border border-danger-ink/30 bg-danger-soft px-4 py-3 text-sm text-danger-ink shadow-soft"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-bold">Storage unavailable — changes won't be saved.</span>{" "}
            NitroAI couldn't open its local database (private browsing or blocked site data can
            cause this), so everything you create here lives in memory only and is lost when this
            window reloads or closes. Export anything you want to keep.
          </span>
        </div>
      )}
      {engineError && (
        <div
          role="alert"
          className="pointer-events-auto flex max-w-3xl items-start gap-2.5 rounded-xl border border-danger-ink/30 bg-danger-soft px-4 py-3 text-sm font-semibold text-danger-ink shadow-soft"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{engineError}</span>
          <button
            type="button"
            onClick={clearEngineError}
            aria-label="Dismiss engine error"
            className="shrink-0 rounded-lg p-0.5 text-danger-ink/70 hover:bg-danger-ink/10 hover:text-danger-ink"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
