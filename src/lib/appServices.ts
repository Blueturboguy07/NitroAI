/* Non-component app plumbing: the single local database and the engine
   builder. Split out of app.tsx (which keeps re-exporting both) so that file
   exports only components and stays HMR-friendly. */

import { Repo } from "./db";
import { idbStore } from "./db/idb";
import { memoryStore } from "./db/memory";
import { createEngine, PUBLIK_DEFAULT_MODELS } from "./engine";
import type { Engine } from "./engine/types";
import { resilient } from "./engine/resilient";
import { loadApiKey, resolveProvider } from "./engine/keys";
import { getEnginePrefs } from "./prefs";
import { fetchPublikStatus, linesToCapabilities, statusToBalance, usageToBalance } from "./publik";
import type { EnginePrefs } from "./types";
import type { StorageKind } from "./appContext";

let repoPromise: Promise<Repo> | null = null;
let storageKind: StorageKind = "indexeddb";

export function getRepo(): Promise<Repo> {
  if (!repoPromise) {
    repoPromise = (async () => {
      try {
        const repo = new Repo(await idbStore());
        storageKind = "indexeddb";
        return repo;
      } catch (e) {
        // IndexedDB blocked (private window, disabled site data, quota…).
        // Keep the app usable, but the UI must say loudly that nothing will
        // survive a reload — see repoStorageKind().
        console.warn("NitroAI: IndexedDB unavailable, using in-memory storage", e);
        storageKind = "memory";
        return new Repo(memoryStore());
      }
    })();
  }
  return repoPromise;
}

/* Which store getRepo() resolved to. Only meaningful after it has resolved. */
export function repoStorageKind(): StorageKind {
  return storageKind;
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
  const provider = resolveProvider(key, prefs.cloudProvider);
  if (!provider) return null;
  return resilient(
    createEngine({
      mode: "cloud",
      provider,
      apiKey: key,
      model: prefs.cloudModel || undefined,
      models: prefs.cloudModels?.[provider],
      ...(provider === "publik" ? { onUsage: usageToBalance } : {}),
    }),
  );
}
