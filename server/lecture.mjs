/* "Trim the solve-time gaps": a lecture link in, a shorter video out.
 *
 *   GET  /api/lecture/status        → { ffmpeg: true|false, message }
 *   POST /api/lecture/trim          → SSE progress; body { url, minGapSeconds?, padSeconds? }
 *   GET  /api/lecture/video?id=     → the trimmed .mp4
 *   GET  /api/lecture/audio?id=     → its sound (.m4a), only when the video had no captions
 *   POST /api/lecture/delete        → body { id }; removes both files
 *
 * All of them are /api/* routes, so the ONE guard (localGuard.mjs) runs
 * first in httpServer.mjs and in the dev plugin. The page plays the video
 * from a fetch() with the app header (a blob), never from a bare <video src>.
 *
 * The steps of a trim: yt-dlp downloads the video and its captions
 * (ytdlp.mjs: the pinned file, the link as one argument after "--");
 * ffmpeg's silencedetect lists the silences; lecturePlan.mjs (pure) decides
 * the cuts from the silences and the caption times; ffmpeg writes the kept
 * parts to a temp folder; the result moves into `mediaDir`.
 *
 * ffmpeg is NOT downloaded. There is no official ffmpeg binary for every
 * platform to pin by SHA-256 the way yt-dlp is pinned, so NitroAI uses the
 * ffmpeg that is already on this computer and says so when there is none.
 *
 * Every process is started with spawn/execFile and an argument list: no
 * shell. A closed connection stops the job, kills the process and deletes
 * the temp folder. One trim runs at a time.
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { downloadLecture, vttToText } from "./ytdlp.mjs";
import { checkYoutubeLink } from "./youtubeLink.mjs";
import {
  PLAN_DEFAULTS,
  PLAN_LIMITS,
  parseMediaInfo,
  parseSilenceDetect,
  pickVideoEncoder,
  planCuts,
  renderArgs,
  vttToSegments,
} from "./lecturePlan.mjs";

const execFileP = promisify(execFile);

export const NEEDS_FFMPEG_MESSAGE =
  "Trimming a video needs ffmpeg on this computer. Install it (Mac: brew install ffmpeg. Windows: winget install ffmpeg. Linux: sudo apt install ffmpeg), then try again.";

/* silencedetect: quieter than -35 dB for at least 1 second is silence. */
const SILENCE_NOISE = "-35dB";
const SILENCE_MIN_SECONDS = 1;
export const TEMP_PREFIX = "nitroai-lecture-";
export const ID_RE = /^[a-f0-9]{32}$/;
const STDERR_LIMIT = 8 * 1024 * 1024;

/* ---- ffmpeg on this computer -------------------------------------------- */

let foundFfmpeg = null;

/* The full path of a working ffmpeg, or null. Looks at NITROAI_FFMPEG, then
   the PATH folders, then the usual install folders (a packaged Mac app does
   not get the shell's PATH). A relative PATH entry is never used. Only a
   file that answers `-version` as ffmpeg counts. */
export async function findFfmpeg({ env = process.env, platform = process.platform } = {}) {
  const cache = env === process.env; // tests pass their own env
  if (cache && foundFfmpeg && fs.existsSync(foundFfmpeg)) return foundFfmpeg;
  const exe = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter);
  if (platform === "win32") {
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
    if (env.ProgramData) dirs.push(path.join(env.ProgramData, "chocolatey", "bin"));
    if (env.USERPROFILE) dirs.push(path.join(env.USERPROFILE, "scoop", "shims"));
    dirs.push("C:\\ffmpeg\\bin");
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin", "/snap/bin");
  }
  const files = [env.NITROAI_FFMPEG, ...dirs.map((d) => (d ? path.join(d, exe) : ""))];
  const seen = new Set();
  for (const file of files) {
    if (!file || !path.isAbsolute(file) || seen.has(file)) continue;
    seen.add(file);
    try {
      if (!fs.statSync(file).isFile()) continue;
      const { stdout } = await execFileP(file, ["-version"], { timeout: 5000, windowsHide: true });
      if (/^ffmpeg version /.test(stdout)) {
        if (cache) foundFfmpeg = file;
        return file;
      }
    } catch {
      /* not there, or not ffmpeg */
    }
  }
  return null;
}

/* One ffmpeg run. Never rejects for an exit code: returns { code, stderr }.
   Rejects when the run is stopped (signal) or cannot start.
   `onSeconds` gets the position ffmpeg has reached (needs -progress pipe:1).
   `timeoutMs` ends a run that takes longer (it then has a non-zero code). */
export function runFfmpeg(bin, args, { signal, onSeconds, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal, timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true });
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => {
      if (!onSeconds) return;
      const all = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
      if (all.length) onSeconds(Number(all[all.length - 1][1]) / 1e6);
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      if (stderr.length < STDERR_LIMIT) stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

const encoders = new Map();
export async function videoEncoder(ffmpeg) {
  if (!encoders.has(ffmpeg)) {
    let text = "";
    try {
      text = (await execFileP(ffmpeg, ["-hide_banner", "-encoders"], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
    } catch {
      /* ffmpeg then picks its own encoder for .mp4 */
    }
    encoders.set(ffmpeg, pickVideoEncoder(text, process.platform));
  }
  return encoders.get(ffmpeg);
}

/* ---- files --------------------------------------------------------------- */

export function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    // Another disk (the temp folder often is): copy, then delete.
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

export function lectureFiles(mediaDir, id) {
  return { video: path.join(mediaDir, `${id}.mp4`), audio: path.join(mediaDir, `${id}.m4a`) };
}

function removeLecture(mediaDir, id) {
  const files = lectureFiles(mediaDir, id);
  let removed = false;
  for (const file of [files.video, files.audio]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed = true;
    }
  }
  return removed;
}

/* Temp folders a crash left behind (older than a day). */
function sweepTemp() {
  try {
    const root = os.tmpdir();
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const dir = path.join(root, name);
      if (Date.now() - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

/* ---- the job ------------------------------------------------------------- */

/* Download, find the gaps, cut, save. Returns the `done` event's fields.
   `emit({ phase, progress })`: phase is "download" | "analyze" | "render" |
   "save"; progress is 0..1. Throws when stopped (signal) or on a failure;
   the temp folder is deleted either way and nothing stays in mediaDir. */
export async function trimLecture({ url, minGapSeconds, padSeconds, binDir, mediaDir, ffmpeg, ytdlp = {}, signal, emit = () => {}, tmpRoot = os.tmpdir() }) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, TEMP_PREFIX));
  const id = randomBytes(16).toString("hex");
  const files = lectureFiles(mediaDir, id);
  let saved = false;
  try {
    emit({ phase: "download", progress: 0 });
    const dl = await downloadLecture(url, binDir, tmp, {
      ...ytdlp,
      ffmpegPath: ffmpeg,
      signal,
      onProgress: (progress) => emit({ phase: "download", progress }),
    });
    signal?.throwIfAborted();

    emit({ phase: "analyze", progress: 0 });
    // `ffmpeg -i file` with no output prints the file's length and streams.
    const probe = await runFfmpeg(ffmpeg, ["-hide_banner", "-nostdin", "-i", dl.videoPath], { signal, timeoutMs: 60_000 });
    const info = parseMediaInfo(probe.stderr);
    if (!info.durationSeconds || (!info.hasVideo && !info.hasAudio)) throw new Error("NitroAI could not read the downloaded video.");
    let silences = [];
    if (info.hasAudio) {
      const run = await runFfmpeg(
        ffmpeg,
        [
          "-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", "-i", dl.videoPath, "-vn", "-sn", "-dn",
          "-af", `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN_SECONDS}`, "-f", "null", "-",
        ],
        { signal, onSeconds: (s) => emit({ phase: "analyze", progress: Math.min(1, s / info.durationSeconds) }) },
      );
      if (run.code !== 0) throw new Error("ffmpeg could not read the sound of this video.");
      silences = parseSilenceDetect(run.stderr, info.durationSeconds);
    }
    const segments = dl.vtt ? vttToSegments(dl.vtt) : [];
    const plan = planCuts({ silences, segments, durationSeconds: info.durationSeconds, minGapSeconds, padSeconds });
    if (plan.keep.length === 0) throw new Error("NitroAI found only silence in this video, so there is nothing to keep.");
    signal?.throwIfAborted();

    let result = dl.videoPath;
    const asIs = plan.summary.cuts === 0 && info.hasVideo && path.extname(dl.videoPath).toLowerCase() === ".mp4";
    if (!asIs) {
      emit({ phase: "render", progress: 0 });
      result = path.join(tmp, "trimmed.mp4");
      const args = renderArgs({
        input: dl.videoPath,
        output: result,
        keep: plan.keep,
        hasVideo: info.hasVideo,
        hasAudio: info.hasAudio,
        encoder: info.hasVideo ? await videoEncoder(ffmpeg) : null,
      });
      const run = await runFfmpeg(ffmpeg, args, {
        signal,
        onSeconds: (s) => emit({ phase: "render", progress: Math.min(1, s / plan.summary.trimmedSeconds) }),
      });
      if (run.code !== 0 || !fs.existsSync(result)) {
        throw new Error(`ffmpeg could not cut the video: ${run.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
      }
    }

    // No captions: the page sends the trimmed sound to be transcribed, as it
    // does for any video without captions. Small: mono, 16 kHz, 32 kb/s.
    const transcript = dl.vtt ? vttToText(dl.vtt) : "";
    let audio = null;
    if (!transcript && info.hasAudio) {
      audio = path.join(tmp, "audio.m4a");
      const run = await runFfmpeg(
        ffmpeg,
        ["-hide_banner", "-nostdin", "-nostats", "-y", "-i", result, "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", audio],
        { signal },
      );
      if (run.code !== 0 || !fs.existsSync(audio)) audio = null;
    }
    signal?.throwIfAborted();

    emit({ phase: "save", progress: 1 });
    fs.mkdirSync(mediaDir, { recursive: true });
    saved = true;
    moveFile(result, files.video);
    if (audio) moveFile(audio, files.audio);
    signal?.throwIfAborted();
    return {
      id,
      title: dl.title,
      transcript,
      hasAudio: !!audio,
      usedTranscript: plan.usedTranscript,
      summary: plan.summary,
    };
  } catch (err) {
    if (saved) removeLecture(mediaDir, id);
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---- the routes ---------------------------------------------------------- */

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readSmallJson(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
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

/* { value } (undefined: use the default) or { error }. Only a number in the
   range is accepted; "30", null, NaN and Infinity are not. */
function checkOption(body, name) {
  const v = body[name];
  if (v === undefined) return { value: undefined };
  const [min, max] = PLAN_LIMITS[name];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    return { error: `${name} must be a number from ${min} to ${max}.` };
  }
  return { value: v };
}

function sendFile(req, res, file, type) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: "This file is not on this computer any more." });
  }
  res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": "no-store" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

/* The handler for /api/lecture/*. Returns true when it answered.
 *   binDir   where yt-dlp is kept (as for /api/youtube-extract);
 *   mediaDir where the trimmed videos are kept;
 *   ffmpeg   (tests) a path, or null for "no ffmpeg"; default: findFfmpeg();
 *   ytdlp    (tests) { pin, fetchImpl } for ytdlp.mjs;
 *   trim     (tests) a stand-in for trimLecture;
 *   tmpRoot  (tests) where the job makes its temp folder. */
export function createLectureHandler({ binDir, mediaDir, ffmpeg, ytdlp, trim = trimLecture, tmpRoot } = {}) {
  let busy = false;
  if (mediaDir) sweepTemp();
  const ffmpegPath = () => (ffmpeg === undefined ? findFfmpeg() : Promise.resolve(ffmpeg));

  return async function handleLecture(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/lecture/")) return false;
    const method = String(req.method ?? "GET").toUpperCase();
    if (!binDir || !mediaDir) {
      sendJson(res, 503, { error: "This server has no folder for videos." });
      return true;
    }

    if (p === "/api/lecture/status") {
      if (method !== "GET") return sendJson(res, 405, { error: "use GET" }), true;
      const found = !!(await ffmpegPath());
      sendJson(res, 200, { ffmpeg: found, message: found ? null : NEEDS_FFMPEG_MESSAGE, defaults: PLAN_DEFAULTS });
      return true;
    }

    if (p === "/api/lecture/video" || p === "/api/lecture/audio") {
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "use GET" }), true;
      const id = url.searchParams.get("id") ?? "";
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: "That is not a video id." }), true;
      const files = lectureFiles(mediaDir, id);
      if (p === "/api/lecture/video") sendFile(req, res, files.video, "video/mp4");
      else sendFile(req, res, files.audio, "audio/mp4");
      return true;
    }

    if (p === "/api/lecture/delete") {
      if (method !== "POST") return sendJson(res, 405, { error: "use POST" }), true;
      const { id } = await readSmallJson(req);
      if (typeof id !== "string" || !ID_RE.test(id)) return sendJson(res, 400, { error: "That is not a video id." }), true;
      sendJson(res, 200, { ok: true, removed: removeLecture(mediaDir, id) });
      return true;
    }

    if (p === "/api/lecture/trim") {
      // POST: it downloads a video and runs ffmpeg for minutes.
      if (method !== "POST") return sendJson(res, 405, { error: "use POST" }), true;
      const body = await readSmallJson(req);
      // Only a YouTube link, as the parsed link (youtubeLink.mjs).
      const link = checkYoutubeLink(body.url);
      if (link.error) return sendJson(res, 400, { error: link.error }), true;
      const minGap = checkOption(body, "minGapSeconds");
      const pad = checkOption(body, "padSeconds");
      if (minGap.error || pad.error) return sendJson(res, 400, { error: minGap.error || pad.error }), true;
      const bin = await ffmpegPath();
      if (!bin) return sendJson(res, 503, { error: NEEDS_FFMPEG_MESSAGE, code: "needs_ffmpeg" }), true;
      if (busy) return sendJson(res, 409, { error: "NitroAI is already trimming a video. Wait for it to finish, then try again." }), true;

      busy = true;
      const stop = new AbortController();
      let open = true;
      res.on("close", () => {
        open = false;
        stop.abort();
      });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      let last = "";
      const emit = (event) => {
        if (!open) return;
        // One event per phase and whole percent, not one per ffmpeg line.
        const key = `${event.phase}:${Math.floor((event.progress ?? 0) * 100)}`;
        if (event.phase !== "done" && event.phase !== "error" && key === last) return;
        last = key;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        const result = await trim({
          url: link.url,
          minGapSeconds: minGap.value,
          padSeconds: pad.value,
          binDir,
          mediaDir,
          ffmpeg: bin,
          ytdlp,
          signal: stop.signal,
          emit,
          tmpRoot,
        });
        // The page went away while the last step ran: keep nothing.
        if (!open) removeLecture(mediaDir, result.id);
        emit({ phase: "done", ...result });
      } catch (err) {
        emit({ phase: "error", message: err instanceof Error ? err.message : "The video could not be trimmed." });
      } finally {
        busy = false;
      }
      if (open) res.end();
      return true;
    }

    sendJson(res, 404, { error: "unknown endpoint" });
    return true;
  };
}
