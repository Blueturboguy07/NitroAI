// @vitest-environment jsdom
/* Every feature, end to end, on a Gemini key — the way the app runs it:
   buildEngine() from prefs + the stored key, then the real pipeline and
   generation code against a fake Gemini API that answers like the real one
   (SSE streams, JSON-schema answers, inline audio, 24 kHz PCM voices). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import { createNoteFromSources } from "./pipeline";
import {
  chatAnswer,
  generateFlashcards,
  generatePodcastScript,
  generateQuiz,
  synthesizePodcastAudio,
} from "./index";
import { parseWav } from "../audio/wav";
import type { Engine } from "../engine/types";

const KEY = "AQ.Ab8RN6LfakeAuthKey_0123456789abcdef";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

interface Seen {
  url: string;
  body: Record<string, any>;
}

function fakeGemini() {
  const seen: Seen[] = [];
  const sse = (text: string) =>
    new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n` +
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] })}\r\n\r\n`,
      { status: 200 },
    );
  const answer = (value: unknown) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP" }] }), {
      status: 200,
    });

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    seen.push({ url, body });
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);

    if (url.startsWith(`${GEMINI}/models?`)) {
      return new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes(":streamGenerateContent")) {
      const system: string = body.systemInstruction?.parts?.[0]?.text ?? "";
      if (body.generationConfig?.maxOutputTokens === 30 + 2048) return sse("Photosynthesis Basics");
      if (/study assistant/i.test(system)) return sse("Chlorophyll absorbs light.");
      return sse("# Photosynthesis\n\nPlants turn **light** into sugar.\n\n- Happens in chloroplasts");
    }
    if (url.includes("-tts:generateContent")) {
      const pcm = btoa(String.fromCharCode(1, 0, 2, 0));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm } }] } }],
        }),
        { status: 200 },
      );
    }
    if (url.includes(":generateContent")) {
      if (body.contents?.[0]?.parts?.[0]?.inlineData) {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "Today we cover photosynthesis." }] } }] }),
          { status: 200 },
        );
      }
      const props = Object.keys(body.generationConfig?.responseJsonSchema?.properties ?? {});
      if (props.includes("topics")) return answer({ topics: ["Light reactions"] });
      if (props.includes("cards")) return answer({ cards: [{ front: "Where?", back: "Chloroplasts", topic: "Light reactions" }] });
      if (props.includes("questions")) {
        return answer({
          questions: [
            {
              type: "mcq",
              topic: "Light reactions",
              difficulty: "basic",
              question: "Where does it happen?",
              options: ["Chloroplasts", "Nucleus", "Ribosome", "Wall"],
              correctIndex: 0,
              explanation: "Chloroplasts hold chlorophyll.",
            },
          ],
        });
      }
      if (props.includes("lines")) {
        return answer({
          lines: [
            { speaker: "host", text: "Welcome!", spoken: "Welcome!" },
            { speaker: "guest", text: "Hi.", spoken: "Hi." },
          ],
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 404, message: `unexpected ${url}` } }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return seen;
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function geminiEngine(prefs: Record<string, unknown> = {}): Promise<Engine> {
  localStorage.setItem("nitroai.apikey", KEY);
  const { buildEngine } = await import("../app");
  const engine = await buildEngine({ mode: "cloud", onboarded: true, language: "English", ...prefs });
  expect(engine?.provider).toBe("gemini");
  return engine!;
}

describe("Gemini key, end to end", () => {
  it("text → note, title, flashcards, quiz, chat, podcast script and audio", async () => {
    const seen = fakeGemini();
    const engine = await geminiEngine();
    const repo = new Repo(memoryStore());

    const id = await createNoteFromSources({ repo, engine, inputs: [{ kind: "text", text: "Plants make sugar from light." }] });
    const note = (await repo.getNote(id))!;
    expect(note.title).toBe("Photosynthesis Basics");
    expect(note.blocks.map((b) => b.type)).toEqual(["heading1", "paragraph", "bullet"]);

    const cards = await generateFlashcards(engine, note);
    expect(cards).toMatchObject([{ front: "Where?", back: "Chloroplasts" }]);

    const quiz = await generateQuiz(engine, note);
    expect(quiz[0]).toMatchObject({ type: "mcq", correctIndex: 0 });

    const reply = await chatAnswer(engine, note, [], "What absorbs light?");
    expect(reply).toBe("Chlorophyll absorbs light.");

    const podcast = await generatePodcastScript(engine, note);
    expect(podcast.script).toHaveLength(2);
    const audio = await synthesizePodcastAudio(engine, podcast);
    expect(audio.type).toBe("audio/wav");
    expect([...parseWav(new Uint8Array(await audio.arrayBuffer())).pcm]).toEqual([1, 0, 2, 0, 1, 0, 2, 0]);

    // Default models: newest Flash for heavy work, Flash-Lite for quick calls.
    const models = seen.filter((s) => s.url.includes("/models/")).map((s) => s.url.split("/models/")[1].split(":")[0]);
    expect(models).toContain("gemini-3.8-flash");
    expect(models).toContain("gemini-3.5-flash-lite");
  });

  it("audio upload is transcribed by Gemini before the notes are written", async () => {
    const seen = fakeGemini();
    const engine = await geminiEngine();
    const repo = new Repo(memoryStore());
    const id = await createNoteFromSources({
      repo,
      engine,
      inputs: [{ kind: "audio", file: new Blob([new Uint8Array(2000)], { type: "audio/mpeg" }), filename: "lecture.mp3" }],
    });
    const note = (await repo.getNote(id))!;
    expect(note.sourceText).toBe("Today we cover photosynthesis.");
    const audioCall = seen.find((s) => s.body.contents?.[0]?.parts?.[0]?.inlineData);
    expect(audioCall?.body.contents[0].parts[0].inlineData.mimeType).toBe("audio/mp3");
  });

  it("models picked in Settings are the ones called", async () => {
    const seen = fakeGemini();
    const engine = await geminiEngine({ cloudModels: { gemini: { strong: "gemini-3.1-pro-preview", fast: "gemini-3.8-flash" } } });
    const repo = new Repo(memoryStore());
    await createNoteFromSources({ repo, engine, inputs: [{ kind: "text", text: "Plants make sugar from light." }] });
    const models = seen.map((s) => s.url.split("/models/")[1]?.split(":")[0]).filter(Boolean);
    expect(models).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash"]); // note body, then title
    expect(seen.some((s) => s.url.includes("/models?"))).toBe(false); // no listing needed
  });
});
