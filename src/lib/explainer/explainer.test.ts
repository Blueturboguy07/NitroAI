/* The explainer video on the page's side: where the text of a slide goes
   (pure: the text measure is a stand-in), and the call that sends the slides
   and the voice to the local server. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLIDE, layoutSlide, wrapLines, type Measure } from "./slides";
import { buildExplainerVideo, NO_VIDEO_SERVER_MESSAGE } from "./video";
import type { Engine } from "../engine/types";

afterEach(() => vi.unstubAllGlobals());

/* Every character is half as wide as the font is tall; bold is 10% wider. */
const measure: Measure = (text, px, bold) => text.length * px * 0.5 * (bold ? 1.1 : 1);

describe("wrapLines", () => {
  const m = (t: string) => t.length * 10;
  it("breaks at spaces so that no line is wider than the limit", () => {
    expect(wrapLines("the value a function gets close to", 120, m)).toEqual(["the value a", "function", "gets close", "to"]);
    expect(wrapLines("short", 120, m)).toEqual(["short"]);
    expect(wrapLines("  many   spaces\nhere ", 1000, m)).toEqual(["many spaces here"]);
    expect(wrapLines("", 120, m)).toEqual([]);
  });
  it("a word that is too wide gets its own line and is not dropped", () => {
    expect(wrapLines("a pneumonoultramicroscopic word", 100, m)).toEqual(["a", "pneumonoultramicroscopic", "word"]);
  });
});

describe("layoutSlide", () => {
  const width = SLIDE.width - 2 * SLIDE.margin;

  it("a short slide uses the full size; every line fits the width", () => {
    const l = layoutSlide({ title: "What is a limit?", bullets: ["The value a function gets close to", "It need not equal the value at the point"], narration: "" }, measure);
    expect(l.title.px).toBe(60);
    expect(l.bulletPx).toBe(36);
    expect(l.title.lines).toEqual(["What is a limit?"]);
    expect(l.bullets.map((b) => b.lines.length)).toEqual([1, 1]);
    expect(l.bullets[1].y).toBeGreaterThan(l.bullets[0].y);
    for (const line of l.title.lines) expect(measure(line, l.title.px, true)).toBeLessThanOrEqual(width);
  });

  it("a full slide (the longest the script may hold) gets smaller text and still ends above the footer", () => {
    const l = layoutSlide({ title: "T".repeat(8) + " word".repeat(14), bullets: Array.from({ length: 4 }, () => "bullet words ".repeat(9).trim()), narration: "" }, measure);
    expect(l.bulletPx).toBeLessThan(36);
    const last = l.bullets[l.bullets.length - 1];
    expect(last.y + last.lines.length * l.bulletLineHeight).toBeLessThanOrEqual(SLIDE.height - 88);
    for (const b of l.bullets) for (const line of b.lines) expect(measure(line, l.bulletPx, false)).toBeLessThanOrEqual(width - 40);
  });

  it("no bullets: only the title", () => {
    expect(layoutSlide({ title: "Summary", bullets: [], narration: "" }, measure).bullets).toEqual([]);
  });
});

describe("buildExplainerVideo", () => {
  const slides = [
    { title: "One", bullets: ["a", "b"], narration: "First words." },
    { title: "Two", bullets: ["c", "d"], narration: "Second words." },
  ];
  const engine = { tts: async (text: string) => new Blob([`mp3:${text}`]) } as unknown as Engine;
  const draw = async (_s: unknown, i: number) => new Blob([`png:${i}`]);
  const b64 = (t: string) => btoa(t);

  it("sends each slide's PNG and voice as base64 JSON with the app header, and returns the id and the length", async () => {
    const seen: Array<{ path: string; method?: string; app: string | null; type: string | null; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        seen.push({ path, method: init?.method, app: h.get("x-nitroai-app"), type: h.get("content-type"), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: "a".repeat(32), seconds: 41.2 }), { headers: { "content-type": "application/json" } });
      }),
    );
    const lines: string[] = [];
    const made = await buildExplainerVideo(engine, slides, { draw, onProgress: (m) => lines.push(m) });
    expect(made).toEqual({ id: "a".repeat(32), seconds: 41.2 });
    expect(seen).toEqual([
      {
        path: "/api/explainer/render",
        method: "POST",
        app: "1",
        type: "application/json",
        body: { slides: [{ png: b64("png:0"), audio: b64("mp3:First words.") }, { png: b64("png:1"), audio: b64("mp3:Second words.") }] },
      },
    ]);
    expect(lines).toEqual(["Recording the voice… 1 of 2", "Recording the voice… 2 of 2", "Drawing the slides…", "Building the video…"]);
  });

  it("the server's words reach the user (no ffmpeg), and a static site says the desktop app is needed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Making a video needs ffmpeg on this computer.", code: "needs_ffmpeg" }), { status: 503, headers: { "content-type": "application/json" } })));
    await expect(buildExplainerVideo(engine, slides, { draw })).rejects.toThrow("Making a video needs ffmpeg on this computer.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })));
    await expect(buildExplainerVideo(engine, slides, { draw })).rejects.toThrow(NO_VIDEO_SERVER_MESSAGE);
  });

  it("a voice that fails stops the job before anything is sent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const broken = { tts: async () => { throw new Error("no voice"); } } as unknown as Engine;
    await expect(buildExplainerVideo(broken, slides, { draw })).rejects.toThrow("no voice");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
