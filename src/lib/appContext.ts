/* The app context object and its hook, kept apart from <AppProvider> (app.tsx)
   so the file that holds the component exports only components. With the
   context in a module of its own, a Vite HMR update of app.tsx no longer mints
   a fresh context object (which made every consumer throw "useApp must be used
   inside <AppProvider>" until a full reload). */

import { createContext, useContext } from "react";
import type { Repo } from "./db";
import type { Engine } from "./engine/types";
import type { EnginePrefs } from "./types";

/* Where notes live. "memory" means IndexedDB could not be opened and the app
   fell back to an in-memory store: everything is lost on reload. */
export type StorageKind = "indexeddb" | "memory";

export interface AppCtx {
  repo: Repo | null;
  engine: Engine | null;
  prefs: EnginePrefs;
  ready: boolean;
  version: number;
  bump: () => void;
  reloadEngine: () => void;
  savePrefs: (p: EnginePrefs) => void;
  /* Which store getRepo() ended up with. */
  storage: StorageKind;
  /* Set when the most recent engine build threw (cleared on the next build). */
  engineError: string | null;
  clearEngineError: () => void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}
