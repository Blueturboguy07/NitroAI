/* "Explainer video": slides + a voice in, one .mp4 out.
 *
 *   POST /api/explainer/render   body { slides: [{ png, audio }] } (base64)
 *                                → { id, seconds }
 *
 * The page writes the script (fast tier), draws each slide as a PNG and gets
 * each slide's voice from the app's text-to-speech call. This route only
 * joins them: every slide is shown for as long as its voice runs. It uses
 * the same ffmpeg as "Trim the solve-time gaps" (lecture.mjs: found on this
 * computer, never downloaded) and saves into the same folder, so the video
 * is played by GET /api/lecture/video?id= and removed by /api/lecture/delete.
 *
 * It is an /api/* route: the one guard (localGuard.mjs) runs first. The
 * files are checked before ffmpeg sees them: a PNG must start as a PNG, a
 * voice file as an MP3, and both have size limits. File names are made
 * here, from numbers only. No shell.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NEEDS_FFMPEG_MESSAGE, TEMP_PREFIX, findFfmpeg, lectureFiles, moveFile, runFfmpeg, videoEncoder } from "./lecture.mjs";
import { parseMediaInfo } from "./lecturePlan.mjs";

export const EXPLAINER_LIMITS = { slides: 12, pngBytes: 4 * 1024 * 1024, audioBytes: 8 * 1024 * 1024, bodyBytes: 48 * 1024 * 1024 };
/* A short rest after each slide's voice. */
const TAIL_SECONDS = 0.4;
/* A slide show of 12 stills takes seconds. A run this long is stuck. */
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30 * 1000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes) {
  return bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_MAGIC);
}

/* An MP3 file: an ID3 tag, or an MPEG audio frame header. */
function isMp3(bytes) {
  if (bytes.length < 128) return false;
  if (bytes.subarray(0, 3).toString("latin1") === "ID3") return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function fromBase64(value, limit) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(limit / 3) * 4 + 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.length <= limit ? bytes : null;
}

/* { slides: [{ png: Buffer, audio: Buffer }] } or { error } in words. */
export function checkExplainerBody(body) {
  const list = body?.slides;
  if (!Array.isArray(list) || list.length === 0) return { error: "Send at least one slide." };
  if (list.length > EXPLAINER_LIMITS.slides) return { error: `Send at most ${EXPLAINER_LIMITS.slides} slides.` };
  const slides = [];
  for (let i = 0; i < list.length; i++) {
    const png = fromBase64(list[i]?.png, EXPLAINER_LIMITS.pngBytes);
    if (!png || !isPng(png)) return { error: `Slide ${i + 1}: the picture is not a PNG file (or is over 4 MB).` };
    const audio = fromBase64(list[i]?.audio, EXPLAINER_LIMITS.audioBytes);
    if (!audio || !isMp3(audio)) return { error: `Slide ${i + 1}: the voice is not an MP3 file (or is over 8 MB).` };
    slides.push({ png, audio });
  }
  return { slides };
}

/* The ffmpeg arguments: each PNG is shown for its voice's length, and the
   pieces are joined. `parts`: [{ png, audio, seconds }] (paths made here). */
export function explainerArgs({ parts, output, encoder = "libx264" }) {
  const args = ["-hide_banner", "-nostdin", "-nostats", "-y"];
  const graph = [];
  let pads = "";
  parts.forEach((p, i) => {
    const t = Number(p.seconds).toFixed(3);
    args.push("-loop", "1", "-framerate", "10", "-t", t, "-i", p.png, "-i", p.audio);
    graph.push(`[${2 * i}:v:0]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
    graph.push(`[${2 * i + 1}:a:0]aformat=sample_rates=44100:channel_layouts=mono,apad,atrim=0:${t},asetpts=PTS-STARTPTS[a${i}]`);
    pads += `[v${i}][a${i}]`;
  });
  graph.push(`${pads}concat=n=${parts.length}:v=1:a=1[v][a]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]");
  if (encoder) args.push("-c:v", encoder);
  if (encoder === "libx264") args.push("-preset", "veryfast", "-crf", "23", "-tune", "stillimage");
  else if (encoder === "h264_videotoolbox") args.push("-b:v", "1500k");
  else if (encoder === "mpeg4") args.push("-q:v", "5");
  args.push("-r", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-f", "mp4", output);
  return args;
}

/* Join the slides. Returns { id, seconds }. Nothing stays on a failure. */
export async function renderExplainer({ slides, mediaDir, ffmpeg, signal, tmpRoot = os.tmpdir() }) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, TEMP_PREFIX));
  try {
    const parts = [];
    for (let i = 0; i < slides.length; i++) {
      const png = path.join(tmp, `slide-${i}.png`);
      const audio = path.join(tmp, `voice-${i}.mp3`);
      fs.writeFileSync(png, slides[i].png);
      fs.writeFileSync(audio, slides[i].audio);
      // Read the picture once before the real run: with `-loop 1`, ffmpeg
      // tries a broken picture again and again and never ends.
      const picture = await runFfmpeg(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", png, "-frames:v", "1", "-f", "null", "-"], { signal, timeoutMs: CHECK_TIMEOUT_MS });
      if (picture.code !== 0) throw new Error(`Slide ${i + 1}: ffmpeg could not read the picture.`);
      const info = parseMediaInfo((await runFfmpeg(ffmpeg, ["-hide_banner", "-nostdin", "-i", audio], { signal, timeoutMs: CHECK_TIMEOUT_MS })).stderr);
      if (!info.hasAudio || !info.durationSeconds) throw new Error(`Slide ${i + 1}: ffmpeg could not read the voice file.`);
      parts.push({ png, audio, seconds: info.durationSeconds + TAIL_SECONDS });
    }
    const output = path.join(tmp, "explainer.mp4");
    const run = await runFfmpeg(ffmpeg, explainerArgs({ parts, output, encoder: await videoEncoder(ffmpeg) }), { signal, timeoutMs: RENDER_TIMEOUT_MS });
    if (run.code !== 0 || !fs.existsSync(output)) {
      throw new Error(`ffmpeg could not make the video: ${run.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    }
    signal?.throwIfAborted();
    const id = randomBytes(16).toString("hex");
    fs.mkdirSync(mediaDir, { recursive: true });
    moveFile(output, lectureFiles(mediaDir, id).video);
    return { id, seconds: Math.round(parts.reduce((n, p) => n + p.seconds, 0) * 1000) / 1000 };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/* The JSON body, up to `limit` bytes. null: too large. {}: not JSON. */
function readJson(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) over = true; // keep reading (and dropping), so the 413 can be sent
      else chunks.push(c);
    });
    req.on("end", () => {
      if (over) return resolve(null);
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/* The handler for /api/explainer/*. Returns true when it answered.
   `ffmpeg`, `render` (tests): as in createLectureHandler. */
export function createExplainerHandler({ mediaDir, ffmpeg, render = renderExplainer, tmpRoot } = {}) {
  let busy = false;
  return async function handleExplainer(req, res, url) {
    if (!url.pathname.startsWith("/api/explainer/")) return false;
    if (url.pathname !== "/api/explainer/render") return sendJson(res, 404, { error: "unknown endpoint" }), true;
    if (String(req.method).toUpperCase() !== "POST") return sendJson(res, 405, { error: "use POST" }), true;
    if (!mediaDir) return sendJson(res, 503, { error: "This server has no folder for videos." }), true;
    const body = await readJson(req, EXPLAINER_LIMITS.bodyBytes);
    if (body === null) return sendJson(res, 413, { error: "The slides are too large to send (over 48 MB)." }), true;
    const checked = checkExplainerBody(body);
    if (checked.error) return sendJson(res, 400, { error: checked.error }), true;
    const bin = ffmpeg === undefined ? await findFfmpeg() : ffmpeg;
    if (!bin) return sendJson(res, 503, { error: NEEDS_FFMPEG_MESSAGE.replace("Trimming a video", "Making a video"), code: "needs_ffmpeg" }), true;
    if (busy) return sendJson(res, 409, { error: "NitroAI is already making a video. Wait for it to finish, then try again." }), true;

    busy = true;
    const stop = new AbortController();
    let open = true;
    res.on("close", () => {
      open = false;
      stop.abort();
    });
    try {
      const result = await render({ slides: checked.slides, mediaDir, ffmpeg: bin, signal: stop.signal, tmpRoot });
      if (open) sendJson(res, 200, result);
      else fs.rmSync(lectureFiles(mediaDir, result.id).video, { force: true });
    } catch (err) {
      if (open) sendJson(res, 502, { error: err instanceof Error ? err.message : "The video could not be made." });
    } finally {
      busy = false;
    }
    return true;
  };
}
