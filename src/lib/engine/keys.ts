import type { Provider } from "../types";

/* API key handling. Prefix auto-detects the provider so one input field powers
   either. Storage prefers the OS keychain via a Tauri command; in web/dev mode
   it falls back to a dedicated localStorage slot (documented as such in the UI). */

export function detectProvider(key: string): Provider | null {
  const k = key.trim();
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

const LS_KEY = "nitroai.apikey";

/* Detect the Tauri runtime without importing the API at module load. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function saveApiKey(key: string): Promise<void> {
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_api_key", { key });
      return;
    } catch {
      /* fall through to localStorage if the command is unavailable */
    }
  }
  localStorage.setItem(LS_KEY, key);
}

export async function loadApiKey(): Promise<string> {
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const k = await invoke<string>("load_api_key");
      if (k) return k;
    } catch {
      /* fall through */
    }
  }
  return localStorage.getItem(LS_KEY) ?? "";
}

export async function clearApiKey(): Promise<void> {
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_api_key");
    } catch {
      /* ignore */
    }
  }
  localStorage.removeItem(LS_KEY);
}
