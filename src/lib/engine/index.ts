/* Engine factory. This is the single entry point generation/UI code should
   use to get an Engine — never `new` a provider class directly, so switching
   providers/modes stays a one-line change at the call site. */

import type { EngineMode, Provider } from "../types";
import type { Engine, EngineCapabilities } from "./types";
import { EngineError } from "./types";
import { OpenAIEngine, type UsageHeaders } from "./openai";
import { AnthropicEngine } from "./anthropic";
import { LocalEngine } from "./local";

export * from "./types";
export { detectProvider } from "./keys";

/* Where the renderer reaches publik API: the local server's proxy, which
   holds the machine's pk_ key (see server/publikProxy.mjs). */
export const PUBLIK_PROXY_BASE_URL = "/api/publik/v1";
export const PUBLIK_DEFAULT_MODELS = { fast: "publik-fast", strong: "publik-balanced" };

export interface CreateEngineOptions {
  mode: EngineMode;
  provider?: Provider;
  apiKey?: string;
  model?: string;
  localBaseUrl?: string;
  /* publik only: proxy base URL, alias model map, capability bits from the
     credential, and the usage-header hook that feeds the balance line. */
  baseUrl?: string;
  models?: { fast: string; strong: string };
  capabilities?: EngineCapabilities;
  onUsage?: (u: UsageHeaders) => void;
}

export function createEngine(opts: CreateEngineOptions): Engine {
  if (opts.mode === "local") {
    return new LocalEngine(opts.localBaseUrl, opts.model);
  }

  if (opts.provider === "publik") {
    // No key here on purpose: the machine credential lives in the local
    // server. `apiKey` is set only when the user pasted a pk_ key of their own.
    return new OpenAIEngine(opts.apiKey ?? "", opts.model, {
      provider: "publik",
      baseUrl: opts.baseUrl ?? PUBLIK_PROXY_BASE_URL,
      models: opts.models ?? { ...PUBLIK_DEFAULT_MODELS },
      capabilities: opts.capabilities,
      onUsage: opts.onUsage,
    });
  }

  if (!opts.apiKey) {
    throw new EngineError("An API key is required for cloud mode.", "auth");
  }

  switch (opts.provider) {
    case "anthropic":
      return new AnthropicEngine(opts.apiKey, opts.model);
    case "openai":
      return new OpenAIEngine(opts.apiKey, opts.model);
    default:
      throw new EngineError("A provider (openai, anthropic or publik) is required for cloud mode.", "unknown");
  }
}

/* Cheap liveness/credentials check without the caller needing to hold onto
   the Engine instance. Throws EngineError on failure. */
export async function validateCredentials(opts: CreateEngineOptions): Promise<void> {
  await createEngine(opts).validate();
}
