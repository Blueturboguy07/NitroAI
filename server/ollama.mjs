/* Ollama lifecycle manager — the "just works" local engine.
 *
 * A non-technical user should never install or start Ollama by hand. When (and
 * ONLY when) they choose the local engine, the shell provisions it:
 *   1. find an existing `ollama` binary, else download the official standalone
 *      build into the app's data dir
 *   2. start `ollama serve` (with CORS opened to the app origin) if not already
 *      running, and keep a handle so it's torn down on quit
 *   3. pull the default chat + embedding models, streaming progress
 *
 * Nothing here runs for cloud/BYO-key users — the shell calls provision() only
 * on the local-mode selection.
 */

import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const HOST = "127.0.0.1";
const PORT = 11434;
export const OLLAMA_URL = `http://${HOST}:${PORT}`;
export const DEFAULT_CHAT_MODEL = "qwen2.5:3b";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

let serveProc = null; // the `ollama serve` we spawned, if any

/* A marker written once the local engine has been fully provisioned. Its
   presence lets the shell restart Ollama on later launches WITHOUT re-running
   the whole flow — and only ever for users who actually chose local. */
function markerPath(binDir) {
  return path.join(binDir, ".provisioned");
}
export function isProvisioned(binDir) {
  try {
    return fs.existsSync(markerPath(binDir));
  } catch {
    return false;
  }
}

/* The official standalone macOS archive: a .tgz holding the `ollama` binary
   plus its runtime libraries (llama-server, libggml-*). We extract the whole
   thing so the binary can find its libs. */
const OLLAMA_DARWIN_TGZ =
  "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz";

/* Locate an ollama binary: PATH first (Homebrew / official installer), then our
   own downloaded copy. Returns null if neither exists yet. */
async function findBinary(binDir) {
  try {
    const { stdout } = await execFileP(process.platform === "win32" ? "where" : "which", ["ollama"]);
    const p = stdout.split("\n")[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* not on PATH */
  }
  const local = path.join(binDir, process.platform === "win32" ? "ollama.exe" : "ollama");
  return fs.existsSync(local) ? local : null;
}

/* Download + unpack the official macOS build into binDir. Windows/Linux users
   are steered to the official installer (see the message below), which is why
   provision() only auto-downloads on macOS. */
async function downloadBinary(binDir, onLog) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform !== "darwin") {
    throw new Error(
      "Automatic Ollama setup isn't available on this platform yet. Install Ollama from https://ollama.com/download, then reopen NitroAI (or use a cloud key instead).",
    );
  }
  onLog?.("Downloading the local AI runtime (Ollama)… this is a one-time ~150 MB download.");
  const res = await fetch(OLLAMA_DARWIN_TGZ, { headers: { "user-agent": "NitroAI" } });
  if (!res.ok) throw new Error(`Couldn't download Ollama (${res.status})`);
  const tgz = path.join(binDir, "ollama-darwin.tgz");
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  onLog?.("Unpacking the local AI runtime…");
  // The archive expands to `ollama` plus its support libraries, all in binDir.
  // Use the absolute path — a Finder-launched signed app gets a minimal PATH
  // that may not resolve a bare `tar`. /usr/bin/tar is always present on macOS.
  execFileSync("/usr/bin/tar", ["xzf", tgz, "-C", binDir]);
  fs.rmSync(tgz, { force: true });
  const bin = path.join(binDir, "ollama");
  if (!fs.existsSync(bin)) {
    throw new Error("The Ollama download didn't contain the expected files. Try again.");
  }
  fs.chmodSync(bin, 0o755);
  return bin;
}

export async function isServing() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilServing(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServing()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/* Start `ollama serve` if nothing is already answering on the port. CORS is
   opened so the app's webview (a different origin) can reach the API. */
async function ensureServing(bin, appOrigin, onLog) {
  if (await isServing()) return; // an existing instance (e.g. the desktop app) is fine
  onLog?.("Starting the local AI runtime…");
  serveProc = spawn(bin, ["serve"], {
    env: {
      ...process.env,
      OLLAMA_HOST: `${HOST}:${PORT}`,
      OLLAMA_ORIGINS: appOrigin ? `${appOrigin},app://*,tauri://*` : "*",
    },
    stdio: "ignore",
    detached: false,
  });
  serveProc.on("exit", () => {
    serveProc = null;
  });
  if (!(await waitUntilServing())) {
    throw new Error("Ollama started but isn't responding. Try reopening NitroAI.");
  }
}

async function hasModel(name) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const body = await res.json();
    return (body.models ?? []).some((m) => m.name === name || m.name === `${name}:latest`);
  } catch {
    return false;
  }
}

/* Pull a model, forwarding Ollama's streamed progress lines to onProgress as
   { model, status, percent }. Resolves when the pull is complete. */
async function pullModel(bin, name, onProgress) {
  if (await hasModel(name)) {
    onProgress?.({ model: name, status: "already installed", percent: 100 });
    return;
  }
  // Use the HTTP API so we get structured progress rather than a TTY bar.
  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Couldn't pull ${name} (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.error) throw new Error(j.error);
      const percent = j.total ? Math.round(((j.completed ?? 0) / j.total) * 100) : undefined;
      onProgress?.({ model: name, status: j.status ?? "pulling", percent });
    }
  }
  onProgress?.({ model: name, status: "ready", percent: 100 });
}

/* Full provisioning for the local engine. Idempotent and safe to call every
   time local mode is active — it no-ops when everything is already present.
   `emit(event)` streams human-readable progress to the UI. */
export async function provision({ binDir, appOrigin, models, emit } = {}) {
  const chat = models?.chat ?? DEFAULT_CHAT_MODEL;
  const embed = models?.embed ?? DEFAULT_EMBED_MODEL;
  const log = (message) => emit?.({ phase: "log", message });

  let bin = await findBinary(binDir);
  if (!bin) {
    emit?.({ phase: "installing", message: "Setting up the local AI runtime…" });
    bin = await downloadBinary(binDir, log);
  }
  emit?.({ phase: "starting", message: "Starting the local AI runtime…" });
  await ensureServing(bin, appOrigin, log);

  for (const model of [chat, embed]) {
    emit?.({ phase: "pulling", model, message: `Downloading model ${model}…` });
    await pullModel(bin, model, (p) =>
      emit?.({ phase: "pulling", model: p.model, percent: p.percent, message: p.status }),
    );
  }
  if (binDir) {
    try {
      fs.writeFileSync(markerPath(binDir), new Date().toISOString());
    } catch {
      /* non-fatal — worst case setup re-runs (fast) next launch */
    }
  }
  emit?.({ phase: "ready", message: "Local AI is ready." });
  return { chat, embed, url: OLLAMA_URL };
}

/* Launch-time restart: if this machine has been provisioned for local use,
   make sure `ollama serve` is running again (it's killed on quit). No model
   pulls, no work for cloud users — a no-op unless the marker exists. */
export async function ensureServingIfProvisioned(binDir, appOrigin) {
  if (!isProvisioned(binDir)) return false;
  if (await isServing()) return true;
  const bin = await findBinary(binDir);
  if (!bin) return false;
  try {
    await ensureServing(bin, appOrigin);
    return true;
  } catch {
    return false;
  }
}

/* Report current provisioning state without changing anything — lets the UI
   decide whether to show a "set up local AI" flow. */
export async function status(binDir) {
  const bin = await findBinary(binDir);
  const serving = await isServing();
  return {
    installed: !!bin,
    serving,
    hasChatModel: serving ? await hasModel(DEFAULT_CHAT_MODEL) : false,
    hasEmbedModel: serving ? await hasModel(DEFAULT_EMBED_MODEL) : false,
  };
}

/* Stop the serve process we started (called on app quit). An Ollama the user
   was already running independently is left untouched. */
export function shutdown() {
  if (serveProc) {
    try {
      serveProc.kill();
    } catch {
      /* already gone */
    }
    serveProc = null;
  }
}
