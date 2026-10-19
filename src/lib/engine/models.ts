/* Model lists for the Settings picker. Each provider is asked live which
   models this key can use, so new releases show up without an app update and
   retired ones drop out; the picker also takes any id typed by hand. */

import type { Provider } from "../types";
import type { ModelInfo } from "./types";
import { listOpenAIModels, OPENAI_DEFAULT_MODELS } from "./openai";
import { ANTHROPIC_DEFAULT_MODELS, listAnthropicModels } from "./anthropic";
import { listGeminiModels } from "./gemini";
import { PUBLIK_DEFAULT_MODELS, PUBLIK_PROXY_BASE_URL } from "./index";

export type Tier = "fast" | "strong";

export async function listModels(provider: Provider, apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  switch (provider) {
    case "openai":
      return listOpenAIModels(apiKey, { signal });
    case "publik":
      return listOpenAIModels(apiKey, { provider: "publik", baseUrl: PUBLIK_PROXY_BASE_URL, signal });
    case "anthropic":
      return listAnthropicModels(apiKey, signal);
    case "gemini":
      return listGeminiModels(apiKey, signal);
  }
}

/* What runs when the user hasn't picked a model for a tier. */
export function defaultModelLabel(provider: Provider, tier: Tier): string {
  switch (provider) {
    case "openai":
      return OPENAI_DEFAULT_MODELS[tier];
    case "anthropic":
      return ANTHROPIC_DEFAULT_MODELS[tier];
    case "publik":
      return PUBLIK_DEFAULT_MODELS[tier];
    case "gemini":
      return tier === "strong" ? "newest Gemini Flash" : "newest Gemini Flash-Lite";
  }
}
