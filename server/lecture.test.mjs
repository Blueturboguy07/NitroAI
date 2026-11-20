/* /api/lecture/* ("Trim the solve-time gaps", lecture.mjs).
 *
 * Part 1: the guard and the input checks, with a stand-in for the job, so
 * nothing is downloaded and no process starts.
 * Part 2 (only when this computer has ffmpeg): the whole job through the
 * HTTP server. The "yt-dlp" is a small shell script (its SHA-256 is the test
 * pin, as in ytdlp.test.mjs) that hands over a 14-second video this test
 * made with ffmpeg: 3 s of tone, 8 s of silence, 3 s of tone. No test
 * reaches the network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "./httpServer.mjs";
import { NEEDS_FFMPEG_MESSAGE, findFfmpeg, runFfmpeg } from "./lecture.mjs";
import { parseMediaInfo } from "./lecturePlan.mjs";

const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const APP = { "x-nitroai-app": "1" };
const JSON_APP = { ...APP, "content-type": "application/json" };
const ID = "0123456789abcdef0123456789abcdef";

const ffmpeg = await findFfmpeg();

let root;
let app;
let trimCalls;
let fetchCalls;

function dirs() {
  const binDir = path.join(root, "bin");
  const mediaDir = path.join(root, "lectures");
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<html></html>");
  return { binDir, mediaDir, distDir };
}

async function start(lecture) {
  // The job's temp folder is made inside this test's own folder.
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  app = await startServer({ ...dirs(), port: 0, lecture: { ...lecture, tmpRoot: path.join(root, "tmp") } });
  return app.url;
}

function post(base, route, body, headers = JSON_APP) {
  return fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/* The events of an SSE answer. */
async function events(res) {
  const text = await res.text();
  return text.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-lecture-test-"));
  trimCalls = [];
  fetchCalls = [];
});
afterEach(async () => {
  if (app) await new Promise((r) => app.server.close(r));
  app = null;
  fs.rmSync(root, { recursive: true, force: true });
});

/* A stand-in for the job: no download, no ffmpeg. */
const standIn = async (job) => {
  trimCalls.push(job);
  job.emit({ phase: "download", progress: 0.5 });
  return { id: ID, title: "Stand-in", transcript: "words", hasAudio: false, usedTranscript: true, summary: { originalSeconds: 100, trimmedSeconds: 60, removedSeconds: 40, cuts: 1 } };
};

describe("/api/lecture/*: the guard", () => {
  it("every route is refused (403) without the app header, and the job never starts", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const plain = { "content-type": "application/json" };
    expect((await fetch(`${base}/api/lecture/status`)).status).toBe(403);
    expect((await fetch(`${base}/api/lecture/video?id=${ID}`)).status).toBe(403);
    expect((await fetch(`${base}/api/lecture/audio?id=${ID}`)).status).toBe(403);
    expect((await post(base, "/api/lecture/trim", { url: LINK }, plain)).status).toBe(403);
    expect((await post(base, "/api/lecture/delete", { id: ID }, plain)).status).toBe(403);
    expect(trimCalls).toEqual([]);
  });

  it("a cross-site page, a rebound Host, a form post and a text/plain post are refused even with the header", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const tries = [
      { ...JSON_APP, "sec-fetch-site": "cross-site" },
      { ...JSON_APP, origin: "https://evil.example" },
      { ...APP, "content-type": "text/plain" },
      { ...APP, "content-type": "application/x-www-form-urlencoded" },
    ];
    for (const headers of tries) {
      expect((await post(base, "/api/lecture/trim", { url: LINK }, headers)).status, JSON.stringify(headers)).toBe(403);
      expect((await post(base, "/api/lecture/delete", { id: ID }, headers)).status).toBe(403);
    }
    // DNS rebinding: the attacker's name in Host (fetch cannot set Host).
    const port = new URL(base).port;
    const rebound = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/lecture/trim", method: "POST", headers: { ...JSON_APP, host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end(JSON.stringify({ url: LINK }));
    });
    expect(rebound).toBe(403);
    expect(trimCalls).toEqual([]);
  });
});

describe("/api/lecture/trim: input checks", () => {
  it("a GET never starts a download", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const res = await fetch(`${base}/api/lecture/trim?url=${encodeURIComponent(LINK)}`, { headers: APP });
    expect(res.status).toBe(405);
    expect(trimCalls).toEqual([]);
  });

  it("only a YouTube link is accepted: options, files, other sites and 127.0.0.1 get 400 and words", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const bad = [
      undefined, "", 42, ["https://youtu.be/dQw4w9WgXcQ"], "--exec=touch /tmp/x", "-o /tmp/x", "file:///etc/passwd",
      "javascript:alert(1)", "http://127.0.0.1:41763/api/health", "https://vimeo.com/1", "https://youtube.com.evil.example/watch?v=x",
      "https://user:pw@www.youtube.com/watch?v=x", "https://www.youtube.com:8443/watch?v=x", "youtube.com/watch?v=x; rm -rf ~",
    ];
    for (const url of bad) {
      const res = await post(base, "/api/lecture/trim", { url });
      expect(res.status, String(url)).toBe(400);
      expect((await res.json()).error).toMatch(/link/i);
    }
    expect(trimCalls).toEqual([]);
  });

  it("the job gets the parsed link, never the typed text", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const res = await post(base, "/api/lecture/trim", { url: "  https://www.youtube.com\\@127.0.0.1/watch?v=dQw4w9WgXcQ " });
    expect(res.status).toBe(200);
    await res.text();
    expect(trimCalls.map((c) => c.url)).toEqual(["https://www.youtube.com/@127.0.0.1/watch?v=dQw4w9WgXcQ"]);
  });

  it("minGapSeconds and padSeconds must be numbers in range", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const bad = [
      { minGapSeconds: "30" }, { minGapSeconds: 4.9 }, { minGapSeconds: 601 }, { minGapSeconds: null }, { minGapSeconds: -1 },
      { minGapSeconds: [30] }, { padSeconds: -0.1 }, { padSeconds: 10.5 }, { padSeconds: "1; rm" }, { padSeconds: {} },
    ];
    for (const extra of bad) {
      const res = await post(base, "/api/lecture/trim", { url: LINK, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await res.json()).error).toMatch(/must be a number from/);
    }
    // 1e999 is Infinity after JSON.parse.
    const inf = await fetch(`${base}/api/lecture/trim`, { method: "POST", headers: JSON_APP, body: `{"url":"${LINK}","minGapSeconds":1e999}` });
    expect(inf.status).toBe(400);
    expect(trimCalls).toEqual([]);

    const ok = await post(base, "/api/lecture/trim", { url: LINK, minGapSeconds: 5, padSeconds: 0 });
    expect(ok.status).toBe(200);
    await ok.text();
    expect(trimCalls[0]).toMatchObject({ url: LINK, minGapSeconds: 5, padSeconds: 0, ffmpeg: "/x/ffmpeg" });
  });

  it("a body that is not JSON, or is too large, is a 400 (no link), not a crash", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const notJson = await fetch(`${base}/api/lecture/trim`, { method: "POST", headers: JSON_APP, body: "url=" + LINK });
    expect(notJson.status).toBe(400);
    const big = await fetch(`${base}/api/lecture/trim`, { method: "POST", headers: JSON_APP, body: JSON.stringify({ url: LINK, x: "a".repeat(64 * 1024) }) }).catch(() => null);
    if (big) expect(big.status).toBe(400);
    expect(trimCalls).toEqual([]);
  });

  it("no ffmpeg: status says so in words and trim answers 503 needs_ffmpeg before any download", async () => {
    const base = await start({ ffmpeg: null, trim: standIn });
    const status = await (await fetch(`${base}/api/lecture/status`, { headers: APP })).json();
    expect(status).toMatchObject({ ffmpeg: false, message: NEEDS_FFMPEG_MESSAGE });
    const res = await post(base, "/api/lecture/trim", { url: LINK });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: NEEDS_FFMPEG_MESSAGE, code: "needs_ffmpeg" });
    expect(trimCalls).toEqual([]);
  });

  it("with ffmpeg: status true; the answer is an event stream that ends with done", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    expect(await (await fetch(`${base}/api/lecture/status`, { headers: APP })).json()).toMatchObject({ ffmpeg: true, message: null });
    const res = await post(base, "/api/lecture/trim", { url: LINK });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const ev = await events(res);
    expect(ev[0]).toEqual({ phase: "download", progress: 0.5 });
    expect(ev[ev.length - 1]).toMatchObject({ phase: "done", id: ID, summary: { cuts: 1 } });
  });

  it("a failed job ends the stream with its message", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: async () => { throw new Error("yt-dlp failed: Video unavailable"); } });
    const ev = await events(await post(base, "/api/lecture/trim", { url: LINK }));
    expect(ev).toEqual([{ phase: "error", message: "yt-dlp failed: Video unavailable" }]);
  });

  it("one trim at a time: the second gets 409, and the next one after the first ends is accepted", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: async (job) => { await gate; return standIn(job); } });
    const first = post(base, "/api/lecture/trim", { url: LINK });
    await vi.waitFor(async () => {
      const second = await post(base, "/api/lecture/trim", { url: LINK });
      expect(second.status).toBe(409);
    });
    release();
    await (await first).text();
    const third = await post(base, "/api/lecture/trim", { url: LINK });
    expect(third.status).toBe(200);
    await third.text();
  });

  it("without a folder for videos the routes answer 503", async () => {
    const { distDir, binDir } = dirs();
    app = await startServer({ distDir, binDir, port: 0, lecture: { ffmpeg: "/x/ffmpeg", trim: standIn } });
    expect((await post(app.url, "/api/lecture/trim", { url: LINK })).status).toBe(503);
    expect((await fetch(`${app.url}/api/lecture/video?id=${ID}`, { headers: APP })).status).toBe(503);
  });
});

describe("/api/lecture/video, /audio, /delete: the id is 32 hex characters, nothing else", () => {
  const badIds = ["", "abc", "../../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", `${ID}/../x`, `${ID}.mp4`, ID.toUpperCase(), `${ID}0`, "%00" + ID.slice(1)];

  it("a bad id is a 400 and reads no file", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const { mediaDir } = dirs();
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(root, "secret.mp4"), "outside the folder");
    for (const id of badIds) {
      for (const route of ["video", "audio"]) {
        const res = await fetch(`${base}/api/lecture/${route}?id=${id}`, { headers: APP });
        expect(res.status, `${route} ${id}`).toBe(400);
      }
    }
    expect((await fetch(`${base}/api/lecture/video?id=../secret`, { headers: APP })).status).toBe(400);
  });

  it("delete: a bad id (or no id, or an id that is not a string) is a 400 and deletes nothing", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const { mediaDir } = dirs();
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, `${ID}.mp4`), "video");
    fs.writeFileSync(path.join(root, "keep.mp4"), "outside");
    for (const id of [...badIds, undefined, 5, [ID], { id: ID }, "../keep"]) {
      expect((await post(base, "/api/lecture/delete", { id })).status, String(id)).toBe(400);
    }
    expect((await fetch(`${base}/api/lecture/delete?id=${ID}`, { headers: APP })).status).toBe(405);
    expect(fs.existsSync(path.join(mediaDir, `${ID}.mp4`))).toBe(true);
    expect(fs.existsSync(path.join(root, "keep.mp4"))).toBe(true);
  });

  it("a good id: the file is served, a missing one is 404, delete removes video and sound", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", trim: standIn });
    const { mediaDir } = dirs();
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, `${ID}.mp4`), "video bytes");
    fs.writeFileSync(path.join(mediaDir, `${ID}.m4a`), "sound");
    const res = await fetch(`${base}/api/lecture/video?id=${ID}`, { headers: APP });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("video bytes");
    expect((await fetch(`${base}/api/lecture/video?id=${"f".repeat(32)}`, { headers: APP })).status).toBe(404);
    expect(await (await post(base, "/api/lecture/delete", { id: ID })).json()).toEqual({ ok: true, removed: true });
    expect(fs.readdirSync(mediaDir)).toEqual([]);
    expect(await (await post(base, "/api/lecture/delete", { id: ID })).json()).toEqual({ ok: true, removed: false });
  });
});

/* ---- Part 2: the whole job, with ffmpeg ---------------------------------- */

/* The stand-in yt-dlp. `--print title`: a title and a length. With
   --skip-download: the captions (when `vtt` is given). Else: the video. */
function fakeYtdlp({ video, argLog, vtt = "", slow = false }) {
  return Buffer.from(
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${argLog}'`,
      'out=""; prev=""; title=0; skip=0',
      'for a in "$@"; do',
      '  [ "$prev" = "-o" ] && out="$a"',
      '  [ "$prev" = "--print" ] && [ "$a" = "title" ] && title=1',
      '  [ "$a" = "--skip-download" ] && skip=1',
      '  prev="$a"',
      "done",
      'if [ "$title" = 1 ]; then echo "Fake Lecture"; echo "14"; exit 0; fi',
      'dir="$(dirname "$out")"',
      `if [ "$skip" = 1 ]; then ${vtt ? `printf '%b' '${vtt.replace(/\n/g, "\\n")}' > "$dir/video.en.vtt"; ` : ""}exit 0; fi`,
      'echo "nitro-progress  50.0%"',
      slow ? "exec sleep 30" : `cp '${video}' "$dir/video.mp4"`,
      'echo "nitro-progress 100.0%"',
      "exit 0",
      "",
    ].join("\n"),
  );
}

function pinFor(bytes) {
  return {
    version: "test",
    asset: "yt-dlp_test",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    url: "https://github.com/yt-dlp/yt-dlp/releases/download/test/yt-dlp_test",
    name: "yt-dlp-test",
  };
}

function ytdlpOpts(bytes) {
  const pin = pinFor(bytes);
  return {
    pin,
    fetchImpl: async (u) => {
      fetchCalls.push(String(u));
      if (String(u) !== pin.url) throw new Error(`unexpected download ${u}`);
      return new Response(bytes, { status: 200 });
    },
  };
}

async function seconds(file) {
  return parseMediaInfo((await runFfmpeg(ffmpeg, ["-hide_banner", "-nostdin", "-i", file])).stderr).durationSeconds;
}

function leftoverTemp() {
  return fs.readdirSync(path.join(root, "tmp"));
}

const CAPTIONS = [
  "WEBVTT", "",
  "00:00:00.000 --> 00:00:03.000", "so take a few minutes on this one", "",
  "00:00:11.000 --> 00:00:14.000", "welcome back let us look at the answer", "",
].join("\n");

describe.skipIf(!ffmpeg || process.platform === "win32")("the whole job with ffmpeg (a 14-second video: tone, 8 s of silence, tone)", () => {
  let fixtures;
  let video;

  beforeAll(() => {
    fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-lecture-test-fx-"));
    video = path.join(fixtures, "lecture.mp4");
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=14",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=14",
      "-af", "volume='if(between(t,3,11),0,1)':eval=frame",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video,
    ]);
  }, 60_000);
  afterAll(() => fs.rmSync(fixtures, { recursive: true, force: true }));

  it("silence only (no captions): 14 s becomes 8 s, the file plays, its sound is ready to transcribe, delete removes it", async () => {
    const argLog = path.join(root, "args.log");
    const base = await start({ ffmpeg, ytdlp: ytdlpOpts(fakeYtdlp({ video, argLog })) });
    const res = await post(base, "/api/lecture/trim", { url: LINK, minGapSeconds: 5, padSeconds: 1 });
    const ev = await events(res);
    const done = ev[ev.length - 1];
    expect(done, JSON.stringify(ev)).toMatchObject({ phase: "done", title: "Fake Lecture", transcript: "", hasAudio: true, usedTranscript: false });
    expect(done.summary.cuts).toBe(1);
    expect(done.summary.originalSeconds).toBeCloseTo(14, 0);
    expect(done.summary.trimmedSeconds).toBeGreaterThan(7.5);
    expect(done.summary.trimmedSeconds).toBeLessThan(8.5);
    expect(ev.map((e) => e.phase)).toEqual(expect.arrayContaining(["download", "analyze", "render", "save", "done"]));
    expect(done.id).toMatch(/^[a-f0-9]{32}$/);

    const { mediaDir } = dirs();
    expect(fs.readdirSync(mediaDir).sort()).toEqual([`${done.id}.m4a`, `${done.id}.mp4`]);
    const measured = await seconds(path.join(mediaDir, `${done.id}.mp4`));
    expect(measured).toBeGreaterThan(7.5);
    expect(measured).toBeLessThan(8.6);

    const got = await fetch(`${base}/api/lecture/video?id=${done.id}`, { headers: APP });
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBe(fs.statSync(path.join(mediaDir, `${done.id}.mp4`)).size);
    expect((await fetch(`${base}/api/lecture/audio?id=${done.id}`, { headers: APP })).status).toBe(200);

    // The link went to yt-dlp as one argument after "--", after the safe options.
    const runs = fs.readFileSync(argLog, "utf8").trim().split("\n");
    expect(runs).toHaveLength(3);
    for (const line of runs) {
      expect(line.startsWith("--ignore-config --no-update "), line).toBe(true);
      expect(line.endsWith(`-- ${LINK}`), line).toBe(true);
    }
    expect(runs[2]).toContain(`--ffmpeg-location ${ffmpeg}`);
    expect(leftoverTemp()).toEqual([]);

    await post(base, "/api/lecture/delete", { id: done.id });
    expect(fs.readdirSync(mediaDir)).toEqual([]);
  }, 60_000);

  it("captions: the phrase and the caption gap give the cut, and the captions come back as the transcript", async () => {
    const argLog = path.join(root, "args.log");
    const base = await start({ ffmpeg, ytdlp: ytdlpOpts(fakeYtdlp({ video, argLog, vtt: CAPTIONS })) });
    const ev = await events(await post(base, "/api/lecture/trim", { url: LINK, minGapSeconds: 5, padSeconds: 1 }));
    const done = ev[ev.length - 1];
    expect(done, JSON.stringify(ev)).toMatchObject({
      phase: "done",
      transcript: "so take a few minutes on this one welcome back let us look at the answer",
      hasAudio: false,
      usedTranscript: true,
      summary: { cuts: 1, trimmedSeconds: 8 },
    });
    const { mediaDir } = dirs();
    expect(fs.readdirSync(mediaDir)).toEqual([`${done.id}.mp4`]);
    expect(await seconds(path.join(mediaDir, `${done.id}.mp4`))).toBeCloseTo(8, 0);
  }, 60_000);

  it("no gap long enough (the default 30 s): 0 cuts, the video is kept whole", async () => {
    const base = await start({ ffmpeg, ytdlp: ytdlpOpts(fakeYtdlp({ video, argLog: path.join(root, "args.log"), vtt: CAPTIONS })) });
    const ev = await events(await post(base, "/api/lecture/trim", { url: LINK }));
    const done = ev[ev.length - 1];
    expect(done).toMatchObject({ phase: "done", summary: { cuts: 0, removedSeconds: 0 } });
    expect(ev.map((e) => e.phase)).not.toContain("render");
    expect(await seconds(path.join(dirs().mediaDir, `${done.id}.mp4`))).toBeCloseTo(14, 0);
  }, 60_000);

  it("cancel: closing the connection stops the download, deletes the temp folder and saves nothing", async () => {
    const base = await start({ ffmpeg, ytdlp: ytdlpOpts(fakeYtdlp({ video, argLog: path.join(root, "args.log"), slow: true })) });
    const stop = new AbortController();
    const res = await fetch(`${base}/api/lecture/trim`, { method: "POST", headers: JSON_APP, body: JSON.stringify({ url: LINK, minGapSeconds: 5 }), signal: stop.signal });
    const reader = res.body.getReader();
    // Wait until the download is running (the 50% line), then leave.
    let seen = "";
    while (!seen.includes('"progress":0.45')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(leftoverTemp()).toHaveLength(1);
    stop.abort();
    await vi.waitFor(() => expect(leftoverTemp()).toEqual([]), { timeout: 5000 });
    const { mediaDir } = dirs();
    expect(fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []).toEqual([]);
    // The server is free again: a new trim is accepted (not 409).
    await vi.waitFor(async () => {
      const again = await post(base, "/api/lecture/trim", { url: "not a link" });
      expect(again.status).toBe(400);
    });
    const status = await fetch(`${base}/api/lecture/status`, { headers: APP });
    expect(status.status).toBe(200);
  }, 30_000);

  it("a yt-dlp that fails ends the stream with an error and leaves no file", async () => {
    const bytes = Buffer.from("#!/bin/sh\necho 'ERROR: Video unavailable' >&2\nexit 1\n");
    const base = await start({ ffmpeg, ytdlp: ytdlpOpts(bytes) });
    const ev = await events(await post(base, "/api/lecture/trim", { url: LINK }));
    expect(ev[ev.length - 1]).toMatchObject({ phase: "error" });
    expect(ev[ev.length - 1].message).toMatch(/Video unavailable/);
    expect(leftoverTemp()).toEqual([]);
  }, 30_000);
});

describe("findFfmpeg", () => {
  it("no ffmpeg in the PATH folders or the override: null. A file that is not ffmpeg does not count", async () => {
    if (process.platform === "win32") return;
    const dir = path.join(root, "bin2");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ffmpeg"), "#!/bin/sh\necho 'not it'\n", { mode: 0o755 });
    const found = await findFfmpeg({ env: { PATH: `${dir}${path.delimiter}relative/dir`, NITROAI_FFMPEG: path.join(dir, "ffmpeg") }, platform: "test" });
    // The usual folders are still looked at; only a real ffmpeg is returned.
    if (found) expect(found).not.toContain(dir);
    else expect(found).toBe(null);
  });

  it("a file that answers as ffmpeg is found by its full path", async () => {
    if (process.platform === "win32") return;
    const dir = path.join(root, "bin3");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ffmpeg"), "#!/bin/sh\necho 'ffmpeg version 9.9 Copyright'\n", { mode: 0o755 });
    expect(await findFfmpeg({ env: { PATH: dir }, platform: process.platform })).toBe(path.join(dir, "ffmpeg"));
  });
});
