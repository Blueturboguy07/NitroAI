/* "Trim the solve-time gaps", the page's side (lecture.ts): the texts, the
   event stream from /api/lecture/trim, and the notes pipeline around it.
   fetch is a stand-in here: nothing is downloaded. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatClock, ingestLectureTrim, lectureOf, lectureStatus, trimProgressText, trimSummaryText, NO_LOCAL_SERVER_MESSAGE } from "./lecture";
import { ingest } from "./index";
import { createNoteFromSources } from "../generation/pipeline";
import { Repo } from "../db";
import { memoryStore } from "../db/memory";
import type { Engine } from "../engine/types";
import type { Job } from "../types";

afterEach(() => vi.unstubAllGlobals());

const URL_ = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const ID = "0123456789abcdef0123456789abcdef";
const SUMMARY = { originalSeconds: 3130, trimmedSeconds: 2322, removedSeconds: 808, cuts: 9 };

function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/* A local server stand-in. `trim` answers POST /api/lecture/trim. */
function server(trim: () => Response, extra: Record<string, () => Response> = {}) {
  const seen: Array<{ path: string; method: string; app: string | null; type: string | null; body: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ path, method: init?.method ?? "GET", app: h.get("x-nitroai-app"), type: h.get("content-type"), body: init?.body ? String(init.body) : null });
      if (path === "/api/lecture/trim") return trim();
      for (const [prefix, answer] of Object.entries(extra)) if (path.startsWith(prefix)) return answer();
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }),
  );
  return seen;
}

describe("the texts", () => {
  it("formatClock", () => {
    expect(formatClock(3130)).toBe("52:10");
    expect(formatClock(2322.4)).toBe("38:42");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(59.6)).toBe("1:00");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it('"Original 52:10 → Trimmed 38:42 (9 cuts)"', () => {
    expect(trimSummaryText(SUMMARY)).toBe("Original 52:10 → Trimmed 38:42 (9 cuts)");
    expect(trimSummaryText({ originalSeconds: 600, trimmedSeconds: 480, cuts: 1 })).toBe("Original 10:00 → Trimmed 8:00 (1 cut)");
    expect(trimSummaryText({ originalSeconds: 600, trimmedSeconds: 600, cuts: 0 })).toBe("Original 10:00 → Trimmed 10:00 (0 cuts)");
  });

  it("the progress line names the step and the percent", () => {
    expect(trimProgressText("download", 0.42)).toBe("Downloading the video… 42%");
    expect(trimProgressText("analyze", 0)).toBe("Finding the solve-time gaps…");
    expect(trimProgressText("render", 0.6)).toBe("Cutting the video… 60%");
    expect(trimProgressText("save", 1)).toBe("Saving the trimmed video…");
  });

  it("lectureOf reads a note's trimmed video, and only a real id", () => {
    expect(lectureOf({ sourceMeta: { url: URL_, lectureId: ID, originalSeconds: 3130, trimmedSeconds: 2322, cuts: 9 } })).toEqual({ id: ID, originalSeconds: 3130, trimmedSeconds: 2322, cuts: 9 });
    expect(lectureOf({ sourceMeta: { url: URL_ } })).toBe(null);
    expect(lectureOf({ sourceMeta: { lectureId: "../../etc/passwd" } })).toBe(null);
    expect(lectureOf({})).toBe(null);
  });
});

describe("ingestLectureTrim", () => {
  it("POSTs the link as JSON with the app header, reports progress, and returns the captions and the summary", async () => {
    const seen = server(() =>
      sse([
        { phase: "download", progress: 0.5 },
        { phase: "analyze", progress: 0 },
        { phase: "render", progress: 0.25 },
        { phase: "save", progress: 1 },
        { phase: "done", id: ID, title: "Calculus 1, lecture 4", transcript: "today we start with limits", hasAudio: false, summary: SUMMARY },
      ]),
    );
    const lines: string[] = [];
    const res = await ingest({ kind: "youtube", url: "youtu.be/dQw4w9WgXcQ", trimGaps: true }, { onProgress: (m) => lines.push(m) });
    expect(seen).toEqual([{ path: "/api/lecture/trim", method: "POST", app: "1", type: "application/json", body: JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }) }]);
    expect(lines).toEqual(["Downloading the video… 50%", "Finding the solve-time gaps…", "Cutting the video… 25%", "Saving the trimmed video…"]);
    expect(res).toEqual({
      text: "today we start with limits",
      title: "Calculus 1, lecture 4",
      meta: { url: "https://youtu.be/dQw4w9WgXcQ", lectureId: ID, originalSeconds: 3130, trimmedSeconds: 2322, cuts: 9 },
    });
  });

  it("without trimGaps the usual YouTube path runs (no video is downloaded)", async () => {
    const seen = server(() => sse([]), {
      "/api/youtube-extract": () => new Response(JSON.stringify({ transcript: "the captions of the video", title: "A talk" }), { headers: { "content-type": "application/json" } }),
    });
    const res = await ingest({ kind: "youtube", url: URL_ });
    expect(res.text).toBe("the captions of the video");
    expect(seen.map((s) => s.path)).toEqual(["/api/youtube-extract"]);
  });

  it("no captions: the trimmed sound comes back to be transcribed", async () => {
    const seen = server(() => sse([{ phase: "done", id: ID, title: null, transcript: "", hasAudio: true, summary: SUMMARY }]), {
      "/api/lecture/audio": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mp4" } }),
    });
    const res = await ingestLectureTrim(URL_);
    expect(res.needsTranscription).toBe(true);
    expect(res.audio?.size).toBe(3);
    expect(res.meta).toMatchObject({ lectureId: ID, cuts: 9, filename: "lecture.m4a" });
    expect(seen.map((s) => s.path)).toEqual(["/api/lecture/trim", `/api/lecture/audio?id=${ID}`]);
  });

  it("no captions and no sound: an error in words, and the video is deleted", async () => {
    const seen = server(() => sse([{ phase: "done", id: ID, title: null, transcript: "", hasAudio: false, summary: SUMMARY }]));
    await expect(ingestLectureTrim(URL_)).rejects.toThrow(/no captions and no sound/);
    expect(seen[seen.length - 1]).toMatchObject({ path: "/api/lecture/delete", method: "POST", body: JSON.stringify({ id: ID }) });
  });

  it("the server's words reach the user: needs ffmpeg (503 JSON) and a failed job (error event)", async () => {
    server(() => new Response(JSON.stringify({ error: "Trimming a video needs ffmpeg on this computer.", code: "needs_ffmpeg" }), { status: 503, headers: { "content-type": "application/json" } }));
    await expect(ingestLectureTrim(URL_)).rejects.toThrow("Trimming a video needs ffmpeg on this computer.");
    server(() => sse([{ phase: "download", progress: 0 }, { phase: "error", message: "yt-dlp failed: Video unavailable" }]));
    await expect(ingestLectureTrim(URL_)).rejects.toThrow("yt-dlp failed: Video unavailable");
  });

  it("a static site (the app shell answers, not the server) and a stream that ends early are errors, not a hang", async () => {
    server(() => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
    await expect(ingestLectureTrim(URL_)).rejects.toThrow(NO_LOCAL_SERVER_MESSAGE);
    server(() => sse([{ phase: "render", progress: 0.4 }]));
    await expect(ingestLectureTrim(URL_)).rejects.toThrow(/stopped answering/);
  });

  it("a link that is not YouTube never reaches the server", async () => {
    const seen = server(() => sse([]));
    await expect(ingestLectureTrim("https://vimeo.com/1")).rejects.toThrow(/doesn't look like a YouTube URL/);
    expect(seen).toEqual([]);
  });

  it("lectureStatus: ffmpeg or not, and null when there is no local server", async () => {
    server(() => sse([]), { "/api/lecture/status": () => new Response(JSON.stringify({ ffmpeg: false, message: "needs ffmpeg" }), { headers: { "content-type": "application/json" } }) });
    expect(await lectureStatus()).toEqual({ ffmpeg: false, message: "needs ffmpeg" });
    server(() => sse([]), { "/api/lecture/status": () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) });
    expect(await lectureStatus()).toBe(null);
  });
});

function fakeEngine(over: Partial<Engine> = {}): Engine {
  return {
    mode: "cloud",
    capabilities: () => ({ chat: true, transcription: true, tts: false, embeddings: false }),
    complete: async () => "## Limits\n\nA limit is the value a function gets close to.",
    structured: async () => ({ title: "Limits" }) as never,
    transcribe: async () => ({ text: "", segments: [] }),
    tts: async () => new Blob(),
    embed: async () => [],
    validate: async () => {},
    ...over,
  } as Engine;
}

describe("the notes pipeline with a trimmed lecture", () => {
  const done = { phase: "done", id: ID, title: "Calculus 1, lecture 4", transcript: "today we start with limits and why they matter", hasAudio: false, summary: SUMMARY };

  it("the note keeps the video's id and the summary, the notes come from the captions, and the progress lines reach the job", async () => {
    server(() => sse([{ phase: "download", progress: 0.5 }, { phase: "render", progress: 0.5 }, done]));
    const repo = new Repo(memoryStore());
    const messages: string[] = [];
    const id = await createNoteFromSources({ repo, engine: fakeEngine(), inputs: [{ kind: "youtube", url: URL_, trimGaps: true }], onProgress: (j: Job) => messages.push(j.message) });
    const note = await repo.getNote(id);
    expect(note?.sourceKind).toBe("youtube");
    expect(note?.sourceText).toBe("today we start with limits and why they matter");
    expect(note?.sourceMeta).toEqual({ url: URL_, lectureId: ID, originalSeconds: 3130, trimmedSeconds: 2322, cuts: 9 });
    expect(note?.blocks.length).toBeGreaterThan(0);
    expect(messages).toEqual(expect.arrayContaining(["Downloading the video… 50%", "Cutting the video… 50%", "Writing your notes…"]));
  });

  it("when the notes fail, the video with no note is deleted from the server", async () => {
    const seen = server(() => sse([done]));
    const repo = new Repo(memoryStore());
    const engine = fakeEngine({ complete: async () => { throw new Error("the model is down"); } });
    await expect(createNoteFromSources({ repo, engine, inputs: [{ kind: "youtube", url: URL_, trimGaps: true }] })).rejects.toThrow();
    await vi.waitFor(() => expect(seen.some((s) => s.path === "/api/lecture/delete" && s.body === JSON.stringify({ id: ID }))).toBe(true));
    expect(await repo.listNotes()).toEqual([]);
  });

  it("stopped by the user: no note, an AbortError, and the fetch got the signal", async () => {
    const stop = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped.", "AbortError")));
          setTimeout(() => stop.abort(), 5);
        }),
      ),
    );
    const repo = new Repo(memoryStore());
    const run = createNoteFromSources({ repo, engine: fakeEngine(), inputs: [{ kind: "youtube", url: URL_, trimGaps: true }], signal: stop.signal });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(await repo.listNotes()).toEqual([]);
  });
});
