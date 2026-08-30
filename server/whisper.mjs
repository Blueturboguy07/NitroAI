/* Local speech-to-text provisioning — Whisper, installed for the user.
 *
 * NitroAI's local engine could always write notes offline but never *hear*
 * anything: audio uploads hard-failed with "add a cloud key". This module is
 * the missing half. It installs a Whisper model onto the machine the same way
 * server/ollama.mjs installs the chat model — automatically, once, with
 * progress — so local mode can transcribe a lecture with no key and no network.
 *
 * The model runs in the app's own renderer (transformers.js on ONNX Runtime
 * Web), so nothing here needs a binary, a compiler, or a background daemon.
 * All this side does is fetch the model files onto disk and serve them:
 *   installWhisper() downloads them into <binDir>/models/<model>/
 *   resolveModelPath() maps a /api/local/models/... request onto that dir
 * The renderer then points transformers.js at that path (env.localModelPath),
 * which is why the download is a real one-time install rather than a browser
 * cache that silently evaporates.
 */

import fs from "node:fs";
import path from "node:path";

/* Whisper sizes we know how to install. Every one is an ONNX export of
   OpenAI's Whisper, int8-quantized so it runs on CPU at a sane speed. `base`
   is the default: small enough to download in under a minute on most
   connections, accurate enough for lecture audio. */
export const WHISPER_MODELS = [
  { id: "whisper-tiny", repo: "onnx-community/whisper-tiny", label: "Tiny", note: "~44 MB · fastest, least accurate" },
  { id: "whisper-base", repo: "onnx-community/whisper-base", label: "Base", note: "~80 MB · recommended" },
  { id: "whisper-small", repo: "onnx-community/whisper-small", label: "Small", note: "~252 MB · most accurate, slowest" },
];

export const DEFAULT_WHISPER_MODEL = "whisper-base";

/* Exactly the files transformers.js asks for when it loads a Whisper pipeline
   with int8 weights — no more (the repos also hold fp16/fp32/q4 copies of every
   ONNX file, and pulling those would multiply the download for nothing). If a
   future transformers.js needs another file, it shows up as a 404 in the
   renderer, so keep this list in step with the pipeline's dtype below. */
const MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

const HF_HOST = "https://huggingface.co";

/* The way out when we can't install the model automatically. Like Ollama's,
   every failure has to end somewhere the user can actually go. */
const MANUAL_HINT =
  "You can retry, or use a cloud key (OpenAI) for transcription instead — everything else still works offline.";

export function resolveModel(id) {
  return WHISPER_MODELS.find((m) => m.id === id) ?? WHISPER_MODELS.find((m) => m.id === DEFAULT_WHISPER_MODEL);
}

function modelsRoot(binDir) {
  return path.join(binDir, "models");
}

function modelDir(binDir, id) {
  return path.join(modelsRoot(binDir), id);
}

/* Map a /api/local/models/<...> request onto the installed model files.
   Returns null for anything that escapes the models dir or doesn't exist, so
   the endpoint can 404 rather than serve arbitrary disk. */
export function resolveModelPath(binDir, relPath) {
  if (!binDir) return null;
  const root = modelsRoot(binDir);
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const resolved = path.normalize(path.join(root, decoded));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/* What's on disk right now, without touching the network — this is what lets
   the UI say "Ready" instead of demanding a download the user already did.
   `bytes` is what's been installed so far, so a half-finished install reads as
   not-installed rather than as ready-but-broken. */
export function whisperStatus(binDir, model = DEFAULT_WHISPER_MODEL) {
  const spec = resolveModel(model);
  const dir = modelDir(binDir ?? "", spec.id);
  let bytes = 0;
  const missing = [];
  for (const file of MODEL_FILES) {
    try {
      const st = fs.statSync(path.join(dir, file));
      if (st.isFile() && st.size > 0) {
        bytes += st.size;
        continue;
      }
    } catch {
      /* fall through to missing */
    }
    missing.push(file);
  }
  return { model: spec.id, installed: missing.length === 0, bytes, missing };
}

/* Content-Length for each file we still need, so the progress bar reflects the
   whole install instead of restarting at 0% seven times. HEAD is cheap and
   redirects to the CDN are followed by fetch; if the host won't answer HEAD we
   just fall back to per-file progress rather than failing the install. */
async function totalBytes(repo, files) {
  let total = 0;
  for (const file of files) {
    try {
      const res = await fetch(`${HF_HOST}/${repo}/resolve/main/${file}`, {
        method: "HEAD",
        headers: { "user-agent": "NitroAI" },
      });
      const len = Number(res.headers.get("content-length"));
      if (res.ok && Number.isFinite(len)) total += len;
    } catch {
      /* leave it out of the total; progress just runs coarser */
    }
  }
  return total;
}

/* Stream one file to disk via a .part temp so an interrupted download can never
   masquerade as an installed model (whisperStatus only counts files that made
   it all the way to their final name). */
async function downloadFile(repo, file, dest, onBytes, signal) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let lastErr = "unknown error";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${HF_HOST}/${repo}/resolve/main/${file}`, {
        headers: { "user-agent": "NitroAI" },
        signal,
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
      } else if (!res.body) {
        lastErr = "empty response";
      } else {
        const out = fs.createWriteStream(tmp);
        try {
          for await (const chunk of res.body) {
            out.write(Buffer.from(chunk));
            onBytes?.(chunk.length);
          }
          await new Promise((resolve, reject) => {
            out.end((err) => (err ? reject(err) : resolve()));
          });
        } catch (err) {
          out.destroy();
          throw err;
        }
        fs.renameSync(tmp, dest);
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      lastErr = err instanceof Error ? err.message : String(err);
    }
    fs.rmSync(tmp, { force: true });
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error(
    `Couldn't download the speech model file "${file}". This is usually a temporary network ` +
      `problem, so trying again often works. ${MANUAL_HINT} (Details: ${lastErr}.)`,
  );
}

/* Install a Whisper model. Idempotent: already-present files are skipped, so
   calling this on every launch (or every transcription) costs one stat per
   file. `emit(event)` streams progress in the same shape the Ollama flow uses,
   so the setup modal renders it with no special-casing. */
export async function installWhisper({ binDir, model = DEFAULT_WHISPER_MODEL, emit, signal } = {}) {
  if (!binDir) throw new Error("No install directory available for the speech model.");
  const spec = resolveModel(model);
  const dir = modelDir(binDir, spec.id);

  const before = whisperStatus(binDir, spec.id);
  if (before.installed) {
    emit?.({ phase: "pulling", model: spec.id, percent: 100, message: "already installed" });
    return { model: spec.id, installed: true, bytes: before.bytes };
  }

  emit?.({ phase: "pulling", model: spec.id, message: "Downloading the speech model…" });
  fs.mkdirSync(dir, { recursive: true });

  const pending = before.missing;
  const total = await totalBytes(spec.repo, pending);
  let done = 0;

  for (const file of pending) {
    await downloadFile(
      spec.repo,
      file,
      path.join(dir, file),
      (n) => {
        done += n;
        emit?.({
          phase: "pulling",
          model: spec.id,
          percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : undefined,
          message: "downloading speech model",
        });
      },
      signal,
    );
  }

  const after = whisperStatus(binDir, spec.id);
  if (!after.installed) {
    throw new Error(`The speech model didn't finish installing (missing ${after.missing.join(", ")}). ${MANUAL_HINT}`);
  }
  emit?.({ phase: "pulling", model: spec.id, percent: 100, message: "ready" });
  return { model: spec.id, installed: true, bytes: after.bytes };
}
