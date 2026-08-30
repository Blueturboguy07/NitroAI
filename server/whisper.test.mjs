/* Regression coverage for "nitro doesn't do local transcription, whisper is
 * not installed at start".
 *
 * Two failure shapes are pinned here:
 *   - the install has to be a real, resumable, idempotent install. A half-
 *     finished download that reports itself as "installed" is worse than no
 *     install at all: the app would then hand transformers.js a truncated
 *     .onnx and fail at transcribe time with something unreadable.
 *   - /api/local/models/ serves files straight off disk to the renderer, so
 *     its path resolution has to refuse to walk out of the models directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WHISPER_MODEL,
  installWhisper,
  resolveModel,
  resolveModelPath,
  whisperStatus,
} from "./whisper.mjs";

let binDir;

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-whisper-test-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(binDir, { recursive: true, force: true });
});

/* Every model file the pipeline loads, written as a byte of filler. */
const FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

function writeInstalled(model = DEFAULT_WHISPER_MODEL, files = FILES) {
  for (const file of files) {
    const dest = path.join(binDir, "models", model, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "x");
  }
}

/* Serves every requested file as one byte, and counts the GETs so a test can
   assert nothing was re-downloaded. */
function stubHub({ failOn = null } = {}) {
  const gets = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = String(url);
      if (init?.method === "HEAD") {
        return { ok: true, status: 200, headers: new Headers({ "content-length": "1" }) };
      }
      gets.push(u);
      if (failOn && u.includes(failOn)) return { ok: false, status: 500, headers: new Headers() };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "1" }),
        body: (async function* () {
          yield new Uint8Array([120]);
        })(),
      };
    }),
  );
  return gets;
}

describe("whisperStatus", () => {
  it("reports not-installed when nothing has been downloaded", () => {
    const status = whisperStatus(binDir);
    expect(status.installed).toBe(false);
    expect(status.missing).toEqual(FILES);
  });

  it("reports installed only once every file the pipeline needs is present", () => {
    writeInstalled(DEFAULT_WHISPER_MODEL, FILES.slice(0, -1));
    expect(whisperStatus(binDir).installed).toBe(false);
    writeInstalled();
    expect(whisperStatus(binDir).installed).toBe(true);
  });

  it("does not count a zero-byte file as installed", () => {
    writeInstalled();
    fs.writeFileSync(path.join(binDir, "models", DEFAULT_WHISPER_MODEL, "tokenizer.json"), "");
    expect(whisperStatus(binDir).installed).toBe(false);
  });

  it("falls back to the default for an unknown model id", () => {
    expect(resolveModel("whisper-enormous").id).toBe(DEFAULT_WHISPER_MODEL);
    expect(whisperStatus(binDir, "whisper-enormous").model).toBe(DEFAULT_WHISPER_MODEL);
  });
});

describe("installWhisper", () => {
  it("downloads every file and reports progress", async () => {
    const gets = stubHub();
    const events = [];
    const result = await installWhisper({ binDir, emit: (e) => events.push(e) });

    expect(result.installed).toBe(true);
    expect(gets).toHaveLength(FILES.length);
    expect(whisperStatus(binDir).installed).toBe(true);
    expect(events.at(-1)).toMatchObject({ percent: 100, message: "ready" });
  });

  /* The whole point of installing to disk instead of leaning on a browser
     cache: a second launch must cost nothing. */
  it("is a no-op when the model is already installed", async () => {
    writeInstalled();
    const gets = stubHub();
    const events = [];
    await installWhisper({ binDir, emit: (e) => events.push(e) });
    expect(gets).toHaveLength(0);
    expect(events).toEqual([
      { phase: "pulling", model: DEFAULT_WHISPER_MODEL, percent: 100, message: "already installed" },
    ]);
  });

  it("only re-downloads the files that are missing", async () => {
    writeInstalled(DEFAULT_WHISPER_MODEL, FILES.slice(0, 4));
    const gets = stubHub();
    await installWhisper({ binDir });
    expect(gets).toHaveLength(FILES.length - 4);
  });

  /* A failed download must not leave anything behind that whisperStatus would
     later read as a complete install. */
  it("leaves no partial file behind when a download fails", async () => {
    stubHub({ failOn: "encoder_model_quantized" });
    await expect(installWhisper({ binDir })).rejects.toThrow(/speech model file/);

    const dir = path.join(binDir, "models", DEFAULT_WHISPER_MODEL);
    const strays = fs.existsSync(path.join(dir, "onnx"))
      ? fs.readdirSync(path.join(dir, "onnx"))
      : [];
    expect(strays).not.toContain("encoder_model_quantized.onnx");
    expect(strays.filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(whisperStatus(binDir).installed).toBe(false);
  });

  it("fails with an actionable message rather than a bare status code", async () => {
    stubHub({ failOn: "config.json" });
    await expect(installWhisper({ binDir })).rejects.toThrow(/cloud key|retry/i);
  });
});

describe("resolveModelPath", () => {
  it("resolves an installed file", () => {
    writeInstalled();
    const resolved = resolveModelPath(binDir, `${DEFAULT_WHISPER_MODEL}/config.json`);
    expect(resolved).toBe(path.join(binDir, "models", DEFAULT_WHISPER_MODEL, "config.json"));
  });

  it("resolves a URL-encoded nested path", () => {
    writeInstalled();
    expect(
      resolveModelPath(binDir, `${DEFAULT_WHISPER_MODEL}%2Fonnx%2Fencoder_model_quantized.onnx`),
    ).toBeTruthy();
  });

  it("refuses to escape the models directory", () => {
    fs.writeFileSync(path.join(binDir, "secret.txt"), "nope");
    expect(resolveModelPath(binDir, "../secret.txt")).toBeNull();
    expect(resolveModelPath(binDir, "..%2Fsecret.txt")).toBeNull();
    expect(resolveModelPath(binDir, `${DEFAULT_WHISPER_MODEL}/../../secret.txt`)).toBeNull();
  });

  it("returns null for a directory or a file that isn't there", () => {
    writeInstalled();
    expect(resolveModelPath(binDir, DEFAULT_WHISPER_MODEL)).toBeNull();
    expect(resolveModelPath(binDir, `${DEFAULT_WHISPER_MODEL}/nope.json`)).toBeNull();
  });
});
