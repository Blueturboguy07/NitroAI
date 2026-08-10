/* Regression coverage for the local-model detection/persistence bug:
 *   - "won't run locally even after I activate ollama"
 *   - "asks to download a local model EVERY TIME ... auto-picks the lighter
 *     qwen ... let the user choose"
 *
 * Root cause: status() always checked for the hardcoded DEFAULT_CHAT_MODEL /
 * DEFAULT_EMBED_MODEL, never whatever the user had actually pulled or chosen
 * before, so returning users (or anyone with a different model already
 * running) got told "not ready" and were sent through the download flow
 * again — which then always pulled the hardcoded default, never their
 * choice. These tests pin the fixed behavior: status()/listModels() report
 * against the CALLER's desired model and expose every pulled tag so the UI
 * can offer a real picker instead of a fresh-download demand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBED_MODEL,
  OLLAMA_URL,
  listModels,
  provision,
  status,
} from "./ollama.mjs";

// findBinary() needs a real string to path.join against; it's never expected
// to find anything at this path, which is fine — none of these tests assert
// on `installed`.
const TEST_BIN_DIR = "/nonexistent-nitroai-test-bin-dir";

function jsonResponse(body, { ok = true, httpStatus = 200 } = {}) {
  return { ok, status: httpStatus, json: async () => body };
}

/* A minimal fake of Ollama's streamed NDJSON /api/pull response — just enough
   shape (`ok`, `status`, a readable `body`) for pullModel()'s reader loop. */
function pullStreamResponse(statusLines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of statusLines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

/* Stubs global fetch as if Ollama is (or isn't) serving with the given
   pulled model tags, and fails any unexpected request loudly instead of
   hanging. */
function stubOllama({ serving, models = [], onPull } = {}) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (!serving) throw new TypeError("fetch failed");
      const u = String(url);
      if (u === `${OLLAMA_URL}/api/tags`) {
        return jsonResponse({ models: models.map((name) => ({ name })) });
      }
      if (u === `${OLLAMA_URL}/api/pull` && init?.method === "POST") {
        return onPull ? onPull(JSON.parse(init.body)) : jsonResponse({}, { ok: false, httpStatus: 500 });
      }
      throw new Error(`unexpected fetch in test: ${init?.method ?? "GET"} ${u}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listModels", () => {
  it("returns every pulled model tag", async () => {
    stubOllama({ serving: true, models: ["qwen2.5:3b", "llama3.1:8b"] });
    expect(await listModels()).toEqual(["qwen2.5:3b", "llama3.1:8b"]);
  });

  it("returns an empty list (not a throw) when Ollama isn't reachable", async () => {
    stubOllama({ serving: false });
    await expect(listModels()).resolves.toEqual([]);
  });

  it("returns an empty list on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { ok: false, httpStatus: 500 })));
    expect(await listModels()).toEqual([]);
  });
});

describe("status", () => {
  it("reports hasChatModel true for a model the user already pulled, even though it isn't the default", async () => {
    stubOllama({ serving: true, models: ["llama3.1:8b", DEFAULT_EMBED_MODEL] });

    const s = await status(TEST_BIN_DIR, "llama3.1:8b", DEFAULT_EMBED_MODEL);

    expect(s.serving).toBe(true);
    expect(s.hasChatModel).toBe(true);
    expect(s.hasEmbedModel).toBe(true);
    expect(s.models).toEqual(["llama3.1:8b", DEFAULT_EMBED_MODEL]);
  });

  it("THE BUG: checking against the hardcoded default reports not-ready even though a model IS pulled and running", async () => {
    // This is exactly what used to happen every launch for anyone not using
    // qwen2.5:3b: Ollama is serving, a perfectly good model is pulled, but
    // the app only ever checked for its one hardcoded default.
    stubOllama({ serving: true, models: ["llama3.1:8b", DEFAULT_EMBED_MODEL] });

    const s = await status(TEST_BIN_DIR, DEFAULT_CHAT_MODEL, DEFAULT_EMBED_MODEL);

    expect(s.serving).toBe(true);
    expect(s.hasChatModel).toBe(false);
    // The fix's escape hatch: the full pulled-model list is still reported,
    // so a caller (or the UI) can recognize llama3.1:8b is right there.
    expect(s.models).toContain("llama3.1:8b");
  });

  it("defaults to the shipped models when the caller doesn't specify one", async () => {
    stubOllama({ serving: true, models: [DEFAULT_CHAT_MODEL, DEFAULT_EMBED_MODEL] });
    const s = await status(TEST_BIN_DIR);
    expect(s.hasChatModel).toBe(true);
    expect(s.hasEmbedModel).toBe(true);
  });

  it("reports not serving, no models, when Ollama is unreachable", async () => {
    stubOllama({ serving: false });
    const s = await status(TEST_BIN_DIR, "llama3.1:8b");
    expect(s.serving).toBe(false);
    expect(s.hasChatModel).toBe(false);
    expect(s.models).toEqual([]);
  });

  it("matches a pulled model whether it's bare or Ollama's own :latest-suffixed form", async () => {
    stubOllama({ serving: true, models: ["llama3.1:8b:latest", DEFAULT_EMBED_MODEL] });
    const s = await status(TEST_BIN_DIR, "llama3.1:8b", DEFAULT_EMBED_MODEL);
    expect(s.hasChatModel).toBe(true);
  });
});

describe("provision", () => {
  it("recognizes an already-pulled non-default model as ready and never re-downloads it", async () => {
    const calls = stubOllama({ serving: true, models: ["llama3.1:8b", DEFAULT_EMBED_MODEL] });

    const events = [];
    const result = await provision({
      models: { chat: "llama3.1:8b", embed: DEFAULT_EMBED_MODEL },
      emit: (e) => events.push(e),
    });

    expect(result.chat).toBe("llama3.1:8b");
    expect(calls.some((c) => c.url.endsWith("/api/pull"))).toBe(false);
    expect(events.some((e) => e.phase === "pulling" && e.message === "already installed")).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "ready" });
  });

  it("pulls the caller's chosen model (not the hardcoded default) when it isn't pulled yet", async () => {
    const calls = stubOllama({
      serving: true,
      models: [DEFAULT_EMBED_MODEL], // chat model NOT present yet
      onPull: (body) => {
        expect(body.model).toBe("llama3.1:8b"); // never silently substitutes the default
        return pullStreamResponse([{ status: "success", completed: 1, total: 1 }]);
      },
    });

    const result = await provision({
      models: { chat: "llama3.1:8b", embed: DEFAULT_EMBED_MODEL },
      emit: () => {},
    });

    expect(result.chat).toBe("llama3.1:8b");
    const pullCall = calls.find((c) => c.url.endsWith("/api/pull"));
    expect(pullCall).toBeDefined();
  });
});
