/* Client side of the "just works" local engine.
 *
 * When the user picks the local engine, the app asks the local server (the
 * desktop shell, or `npm run serve`) to provision it: install and start Ollama,
 * pull the default chat/embedding models, and install the Whisper model that
 * makes audio uploads work offline — streaming progress back. This is the only
 * place that provisioning is triggered, so cloud/BYO-key users never download
 * anything.
 *
 * If no provisioning server is present (a plain static deploy, or `npm run dev`
 * without the server), setup is simply unavailable and the caller proceeds —
 * the local engine then expects a manually-running Ollama, matching how a
 * developer would use it.
 */

export interface LocalSetupEvent {
  phase: "installing" | "starting" | "pulling" | "log" | "ready" | "done" | "error";
  message?: string;
  model?: string;
  percent?: number;
  /* Only present on the terminal "done" event: the models that were actually
     provisioned (the caller's desired models, or the default). This is what a
     caller should persist as the user's chosen model going forward. */
  chat?: string;
  embed?: string;
  whisper?: string;
}

/* What the server reports is installed on this machine. `whisper` is the
   speech-to-text model — a separate install from the chat model, and the one
   local mode used to be missing entirely, which is why audio uploads failed. */
export interface WhisperStatus {
  model: string;
  installed: boolean;
  bytes: number;
}

export interface DesiredModels {
  /* Leave unset to mean "the shipped default" — see server/ollama.mjs. Passing
     the user's previously-chosen (or already-pulled) model is what makes
     status/setup respect it instead of only ever knowing our one default. */
  chatModel?: string;
  embedModel?: string;
  whisperModel?: string;
}

function query(desired?: DesiredModels): string {
  const params = new URLSearchParams();
  if (desired?.chatModel) params.set("chatModel", desired.chatModel);
  if (desired?.embedModel) params.set("embedModel", desired.embedModel);
  if (desired?.whisperModel) params.set("whisperModel", desired.whisperModel);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/* Does a provisioning server answer here? Returns its reported status, or null
   when there's no server (so the UI can skip the setup step). `models` is
   every model tag Ollama already has pulled — enough for a picker over real,
   already-downloaded models instead of demanding a fresh download. */
export async function localSetupStatus(desired?: DesiredModels): Promise<{
  installed: boolean;
  serving: boolean;
  hasChatModel: boolean;
  hasEmbedModel: boolean;
  models: string[];
  whisper?: WhisperStatus;
} | null> {
  try {
    const res = await fetch(`/api/local/status${query(desired)}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null; // a static host's SPA fallback
    const body = await res.json();
    return { models: [], ...body };
  } catch {
    return null;
  }
}

/* Read one of the server's Server-Sent Events setup streams to completion,
   forwarding every progress event. Uses a streamed fetch (not EventSource) so
   it works under the app's strict same-origin setup. Shared by the full local
   setup and the speech-model-only install, which speak the same event shape. */
async function consumeSetupStream(
  path: string,
  onEvent: (e: LocalSetupEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, { signal });
  if (!res.ok || !res.body) throw new Error(`Local setup unavailable (${res.status}).`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminal = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let event: LocalSetupEvent;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      onEvent(event);
      if (event.phase === "error") {
        sawTerminal = true;
        throw new Error(event.message || "Local setup failed.");
      }
      if (event.phase === "done") sawTerminal = true;
    }
  }
  if (!sawTerminal) throw new Error("Local setup ended unexpectedly.");
}

/* Run provisioning, forwarding each progress event to `onEvent`. Resolves when
   the local engine is ready; rejects on a reported error. `desired` pulls a
   specific model (from a picker, or one already chosen in a prior session)
   instead of always the hardcoded default. */
export function runLocalSetup(
  onEvent: (e: LocalSetupEvent) => void,
  signal?: AbortSignal,
  desired?: DesiredModels,
): Promise<void> {
  return consumeSetupStream(`/api/local/setup${query(desired)}`, onEvent, signal);
}

/* Install just the speech-to-text model. Separate from the full setup so that
   changing the Whisper size in Settings — or a user who set local mode up
   before this existed — doesn't re-run the whole Ollama provisioning flow. */
export function runWhisperSetup(
  onEvent: (e: LocalSetupEvent) => void,
  signal?: AbortSignal,
  model?: string,
): Promise<void> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : "";
  return consumeSetupStream(`/api/local/whisper/setup${qs}`, onEvent, signal);
}
