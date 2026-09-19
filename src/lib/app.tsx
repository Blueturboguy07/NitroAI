/* App-wide context: opens the local database once, builds the active engine from
   prefs + stored key, and exposes both to every page. A `version` counter lets
   pages cheaply refresh their data after writes. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Repo } from "./db";
import { idbStore } from "./db/idb";
import { memoryStore } from "./db/memory";
import { createEngine, PUBLIK_DEFAULT_MODELS } from "./engine";
import type { Engine } from "./engine/types";
import { resilient } from "./engine/resilient";
import { detectProvider, loadApiKey } from "./engine/keys";
import { getEnginePrefs, saveEnginePrefs } from "./prefs";
import { fetchPublikStatus, linesToCapabilities, statusToBalance, usageToBalance } from "./publik";
import type { EnginePrefs } from "./types";
import { reconcileJobs } from "./generation/pipeline";

let repoPromise: Promise<Repo> | null = null;
export function getRepo(): Promise<Repo> {
  if (!repoPromise) {
    repoPromise = (async () => {
      try {
        return new Repo(await idbStore());
      } catch {
        return new Repo(memoryStore());
      }
    })();
  }
  return repoPromise;
}

/* Build the engine described by prefs. Returns null if not configured (no mode
   picked, cloud mode without a valid key, or publik mode with no credential —
   the app then degrades to "Set up your engine in Settings", never a dialog). */
export async function buildEngine(
  prefs: EnginePrefs = getEnginePrefs(),
): Promise<Engine | null> {
  if (!prefs.mode) return null;
  if (prefs.mode === "local") {
    return resilient(createEngine({ mode: "local", model: prefs.localModel || undefined }));
  }

  if (prefs.mode === "publik") {
    // The credential lives in the local server; the renderer only learns
    // whether it is ready and which aliases to use. The user's own key slot
    // is never read on this path.
    const s = await fetchPublikStatus();
    if (!s.available || s.state !== "ready") return null;
    // The starter grant and claim link seed the balance store so the
    // low-starter banner has its denominator and its one link.
    statusToBalance(s);
    return resilient(
      createEngine({
        mode: "cloud",
        provider: "publik",
        baseUrl: s.baseUrl,
        models: {
          fast: s.models?.fast ?? PUBLIK_DEFAULT_MODELS.fast,
          strong: s.models?.balanced ?? PUBLIK_DEFAULT_MODELS.strong,
        },
        capabilities: linesToCapabilities(s.lines),
        onUsage: usageToBalance,
      }),
    );
  }

  // "cloud" = the user's own key. Unchanged, except a pasted pk_ key now
  // routes to publik API (through the local proxy). The publik credential is
  // never consulted here — the user's choice wins even if a file exists.
  const key = await loadApiKey();
  const provider = detectProvider(key);
  if (!provider) return null;
  return resilient(
    createEngine({
      mode: "cloud",
      provider,
      apiKey: key,
      model: prefs.cloudModel || undefined,
      ...(provider === "publik" ? { onUsage: usageToBalance } : {}),
    }),
  );
}

interface AppCtx {
  repo: Repo | null;
  engine: Engine | null;
  prefs: EnginePrefs;
  ready: boolean;
  version: number;
  bump: () => void;
  reloadEngine: () => void;
  savePrefs: (p: EnginePrefs) => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [prefs, setPrefs] = useState<EnginePrefs>(() => getEnginePrefs());
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const reloadEngine = useCallback(() => {
    const p = getEnginePrefs();
    setPrefs(p);
    buildEngine(p).then(setEngine);
  }, []);

  const savePrefs = useCallback(
    (p: EnginePrefs) => {
      saveEnginePrefs(p);
      setPrefs(p);
      buildEngine(p).then(setEngine);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await getRepo();
      await reconcileJobs(r).catch(() => {});
      const e = await buildEngine().catch(() => null);
      if (!alive) return;
      setRepo(r);
      setEngine(e);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo<AppCtx>(
    () => ({ repo, engine, prefs, ready, version, bump, reloadEngine, savePrefs }),
    [repo, engine, prefs, ready, version, bump, reloadEngine, savePrefs],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}
