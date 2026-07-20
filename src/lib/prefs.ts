import type { EnginePrefs } from "./types";

/* Engine preferences persist in localStorage. The API key is NOT here — it lives
   in the OS keychain (Tauri) or a separate localStorage slot in web mode; see
   engine/keys.ts. `mode` is null until the user explicitly picks at onboarding. */

const KEY = "nitroai.prefs";

const defaults: EnginePrefs = {
  mode: null,
  onboarded: false,
  cloudModel: "",
  localModel: "",
  language: "English",
};

export function getEnginePrefs(): EnginePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...(JSON.parse(raw) as Partial<EnginePrefs>) };
  } catch {
    return { ...defaults };
  }
}

export function saveEnginePrefs(prefs: EnginePrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

export function updateEnginePrefs(patch: Partial<EnginePrefs>): EnginePrefs {
  const next = { ...getEnginePrefs(), ...patch };
  saveEnginePrefs(next);
  return next;
}
