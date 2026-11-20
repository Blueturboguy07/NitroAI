/* POST /api/explainer/render (explainer.mjs): slides (PNG) + voice (MP3) in,
 * one .mp4 out. Part 1: the guard and the input checks, with a stand-in for
 * the render. Part 2 (only with ffmpeg that can write MP3): the real render
 * on pictures and tones this test makes with ffmpeg. No network. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./httpServer.mjs";
import { EXPLAINER_LIMITS, checkExplainerBody, explainerArgs } from "./explainer.mjs";
import { findFfmpeg, runFfmpeg } from "./lecture.mjs";
import { parseMediaInfo } from "./lecturePlan.mjs";

const APP = { "x-nitroai-app": "1" };
const JSON_APP = { ...APP, "content-type": "application/json" };
const ID = "0123456789abcdef0123456789abcdef";

const ffmpeg = await findFfmpeg();
const canMp3 = !!ffmpeg && /libmp3lame/.test(execFileSync(ffmpeg, ["-hide_banner", "-encoders"]).toString());

/* The smallest files that pass the checks: a PNG header, an MP3 frame header. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200)]).toString("base64");
const b64 = (text) => Buffer.from(text).toString("base64");

let root;
let app;
let renders;

async function start(explainer, withMedia = true) {
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<html></html>");
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  app = await startServer({ distDir, binDir: path.join(root, "bin"), mediaDir: withMedia ? path.join(root, "lectures") : undefined, port: 0, explainer: { ...explainer, tmpRoot: path.join(root, "tmp") } });
  return app.url;
}
const post = (base, body, headers = JSON_APP) => fetch(`${base}/api/explainer/render`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const standIn = async (job) => {
  renders.push(job);
  return { id: ID, seconds: 12.5 };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-explainer-test-"));
  renders = [];
});
afterEach(async () => {
  if (app) await new Promise((r) => app.server.close(r));
  app = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("/api/explainer/render: the guard and the input checks", () => {
  it("refused (403) without the app header, from another site, or as a form or text/plain post", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", render: standIn });
    const body = { slides: [{ png: PNG, audio: MP3 }] };
    for (const headers of [
      { "content-type": "application/json" },
      { ...JSON_APP, "sec-fetch-site": "cross-site" },
      { ...JSON_APP, origin: "https://evil.example" },
      { ...APP, "content-type": "text/plain" },
      { ...APP, "content-type": "multipart/form-data; boundary=x" },
    ]) {
      expect((await post(base, body, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    expect(renders).toEqual([]);
  });

  it("GET is 405; another /api/explainer path is 404", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", render: standIn });
    expect((await fetch(`${base}/api/explainer/render`, { headers: APP })).status).toBe(405);
    expect((await fetch(`${base}/api/explainer/other`, { headers: APP })).status).toBe(404);
  });

  it("slides must be 1 to 12 real PNG + MP3 pairs: anything else is a 400 in words and ffmpeg never runs", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", render: standIn });
    const good = { png: PNG, audio: MP3 };
    const bad = [
      {}, { slides: [] }, { slides: "x" }, { slides: [null] }, { slides: [{}] },
      { slides: Array.from({ length: EXPLAINER_LIMITS.slides + 1 }, () => good) },
      { slides: [{ png: b64("<svg onload=alert(1)>" + "x".repeat(40)), audio: MP3 }] }, // not a PNG
      { slides: [{ png: PNG, audio: b64("#!/bin/sh\nrm -rf ~\n" + "x".repeat(200)) }] }, // not an MP3
      { slides: [{ png: "../../etc/passwd", audio: MP3 }] }, // a path, not base64
      { slides: [{ png: "/etc/passwd", audio: MP3 }] },
      { slides: [{ png: PNG, audio: 7 }] },
      { slides: [good, { png: PNG }] },
    ];
    for (const body of bad) {
      const res = await post(base, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect((await post(base, "not json")).status).toBe(400);
    expect(renders).toEqual([]);
  });

  it("a picture over 4 MB is a 400; a body over 48 MB is a 413", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", render: standIn });
    const bigPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(EXPLAINER_LIMITS.pngBytes)]).toString("base64");
    expect((await post(base, { slides: [{ png: bigPng, audio: MP3 }] })).status).toBe(400);
    const res = await post(base, `{"slides":[],"x":"${"a".repeat(EXPLAINER_LIMITS.bodyBytes)}"}`);
    expect(res.status).toBe(413);
    expect(renders).toEqual([]);
  }, 30_000);

  it("good slides reach the render as bytes; the answer is { id, seconds }", async () => {
    const base = await start({ ffmpeg: "/x/ffmpeg", render: standIn });
    const res = await post(base, { slides: [{ png: PNG, audio: MP3 }, { png: PNG, audio: MP3 }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, seconds: 12.5 });
    expect(renders).toHaveLength(1);
    expect(renders[0].slides).toHaveLength(2);
    expect(Buffer.isBuffer(renders[0].slides[0].png)).toBe(true);
    expect(renders[0].ffmpeg).toBe("/x/ffmpeg");
  });

  it("no ffmpeg: 503 needs_ffmpeg in words. No folder for videos: 503. A failed render: 502 with its message", async () => {
    let base = await start({ ffmpeg: null, render: standIn });
    let res = await post(base, { slides: [{ png: PNG, audio: MP3 }] });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "needs_ffmpeg", error: expect.stringMatching(/^Making a video needs ffmpeg/) });
    await new Promise((r) => app.server.close(r));

    base = await start({ ffmpeg: "/x/ffmpeg", render: standIn }, false);
    expect((await post(base, { slides: [{ png: PNG, audio: MP3 }] })).status).toBe(503);
    await new Promise((r) => app.server.close(r));

    base = await start({ ffmpeg: "/x/ffmpeg", render: async () => { throw new Error("Slide 1: ffmpeg could not read the voice file."); } });
    res = await post(base, { slides: [{ png: PNG, audio: MP3 }] });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Slide 1: ffmpeg could not read the voice file." });
    expect(renders).toEqual([]);
  });

  it("checkExplainerBody and explainerArgs (pure)", () => {
    expect(checkExplainerBody({ slides: [{ png: PNG, audio: MP3 }] }).slides).toHaveLength(1);
    expect(checkExplainerBody({ slides: [{ png: PNG, audio: b64("ID3" + "x".repeat(200)) }] }).slides).toHaveLength(1);
    expect(checkExplainerBody(null).error).toBe("Send at least one slide.");
    const args = explainerArgs({ parts: [{ png: "/t/slide-0.png", audio: "/t/voice-0.mp3", seconds: 3.4 }, { png: "/t/slide-1.png", audio: "/t/voice-1.mp3", seconds: 2 }], output: "/t/out.mp4" });
    expect(args.join(" ")).toContain("-loop 1 -framerate 10 -t 3.400 -i /t/slide-0.png -i /t/voice-0.mp3 -loop 1 -framerate 10 -t 2.000 -i /t/slide-1.png -i /t/voice-1.mp3");
    expect(args[args.indexOf("-filter_complex") + 1]).toMatch(/\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/);
    expect(args[args.length - 1]).toBe("/t/out.mp4");
  });
});

describe.skipIf(!canMp3)("the real render with ffmpeg (3 slides with voices of 2 s, 3 s and 1.5 s)", () => {
  let fx;
  let slides;
  beforeAll(() => {
    fx = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-explainer-test-fx-"));
    slides = [[2, "red"], [3, "green"], [1.5, "blue"]].map(([seconds, color], i) => {
      const png = path.join(fx, `s${i}.png`);
      const mp3 = path.join(fx, `v${i}.mp3`);
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:d=1`, "-frames:v", "1", png]);
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${300 + i * 100}:sample_rate=24000:duration=${seconds}`, "-c:a", "libmp3lame", "-b:a", "48k", mp3]);
      return { png: fs.readFileSync(png).toString("base64"), audio: fs.readFileSync(mp3).toString("base64") };
    });
  }, 60_000);
  afterAll(() => fs.rmSync(fx, { recursive: true, force: true }));

  it("the video is as long as the voices (+0.4 s each), has picture and sound, plays from /api/lecture/video, and delete removes it", async () => {
    const base = await start({ ffmpeg });
    const res = await post(base, { slides });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(body.seconds).toBeGreaterThan(7.6); // 6.5 s of voice + 3 × 0.4 s
    expect(body.seconds).toBeLessThan(8.1);

    const file = path.join(root, "lectures", `${body.id}.mp4`);
    const info = parseMediaInfo((await runFfmpeg(ffmpeg, ["-hide_banner", "-nostdin", "-i", file])).stderr);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.durationSeconds - body.seconds)).toBeLessThan(0.3);

    const got = await fetch(`${base}/api/lecture/video?id=${body.id}`, { headers: APP });
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBe(fs.statSync(file).size);
    expect(fs.readdirSync(path.join(root, "tmp"))).toEqual([]);

    await fetch(`${base}/api/lecture/delete`, { method: "POST", headers: JSON_APP, body: JSON.stringify({ id: body.id }) });
    expect(fs.existsSync(file)).toBe(false);
  }, 60_000);

  it("a PNG header with no picture behind it: 502 in words, and nothing is saved", async () => {
    const base = await start({ ffmpeg });
    const res = await post(base, { slides: [{ png: PNG, audio: slides[0].audio }] });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Slide 1: ffmpeg could not read the picture.");
    const dir = path.join(root, "lectures");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(fs.readdirSync(path.join(root, "tmp"))).toEqual([]);
  }, 60_000);
});
