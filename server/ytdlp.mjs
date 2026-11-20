/* Shared yt-dlp extraction — used by BOTH the vite dev/preview plugin
 * (vite.youtube-plugin.ts) and the packaged Electron shell's local server
 * (server/httpServer.mjs). YouTube's PoToken/BotGuard gate empties in-browser
 * caption fetches, so the only reliable free path is a local yt-dlp process:
 * captions first, audio fallback for Whisper. yt-dlp is downloaded on first
 * use so a non-technical user installs nothing by hand.
 *
 * Round 7 (hardening): in v0.2.1 and v0.2.2 any web page could give yt-dlp
 * one argument, for example --update-to=<a repo of the attacker>@<tag>,
 * which replaces the cached binary (userData/bin/yt-dlp) with the attacker's
 * file. So now:
 *   - ONE yt-dlp release is pinned here (version + the SHA-256 of each
 *     platform's file, from that release's SHA2-256SUMS). "latest" is never
 *     downloaded.
 *   - The file is kept at a versioned path, bin/yt-dlp-<version>[.exe]. The
 *     old bin/yt-dlp[.exe] (and any other yt-dlp version) is NEVER run and is
 *     deleted on startup (cleanOldYtdlp) and before each use.
 *   - The SHA-256 is checked after the download and before EVERY run. The
 *     result is kept per path with the file's size, mtime, ctime and inode, so an
 *     unchanged file is not hashed again; a changed file is. A file that does
 *     not match is deleted and downloaded again.
 *   - Every run gets --ignore-config and --no-update, and "--" before the
 *     link, so a link can never be read as an option.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const RUN_TIMEOUT_MS = 300_000;
const AUDIO_EXTS = new Set(["m4a", "webm", "mp3", "opus", "wav", "mp4", "aac", "ogg"]);

/* The pinned release. To update: take a new tag from
   https://github.com/yt-dlp/yt-dlp/releases, copy the lines for these files
   from its SHA2-256SUMS, and change VERSION. Sizes are from the same release
   and stop a download that is too large. */
export const YTDLP_VERSION = "2026.10.26";
export const YTDLP_FILES = {
  "darwin-arm64": { asset: "yt-dlp_macos", sha256: "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa", size: 37466304 },
  "darwin-x64": { asset: "yt-dlp_macos", sha256: "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa", size: 37466304 },
  "win32-x64": { asset: "yt-dlp.exe", sha256: "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d", size: 23575744 },
  "win32-arm64": { asset: "yt-dlp_arm64.exe", sha256: "0066dbac3c124028e2dcae2a197fccee33cd91f456313d24f7af89fd54590e98", size: 22809590 },
  "win32-ia32": { asset: "yt-dlp_x86.exe", sha256: "c0407c66361f50a99e10949ae882ea2ad7de9086b75d226d8fd88da4f74828fa", size: 18618344 },
  "linux-x64": { asset: "yt-dlp_linux", sha256: "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795", size: 41166968 },
  "linux-arm64": { asset: "yt-dlp_linux_aarch64", sha256: "e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483", size: 40789792 },
  // Any other platform: the Python zipapp (needs python3 on the PATH).
  other: { asset: "yt-dlp", sha256: "e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3", size: 3073072 },
};

/* Options on EVERY run: read no config file (a config file can add any
   option), never update itself. */
export const YTDLP_SAFE_ARGS = ["--ignore-config", "--no-update"];

/* The pinned file for this machine: { version, asset, sha256, size, url, name }. */
export function ytdlpPin(platform = process.platform, arch = process.arch) {
  const file = YTDLP_FILES[`${platform}-${arch}`] ?? YTDLP_FILES.other;
  return {
    version: YTDLP_VERSION,
    ...file,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${file.asset}`,
    name: `yt-dlp-${YTDLP_VERSION}${platform === "win32" ? ".exe" : ""}`,
  };
}

/* Delete every yt-dlp file in `dir` that is not the pinned one: the old
   unversioned bin/yt-dlp[.exe] (it may be an attacker's file, see above),
   other versions, and partial downloads. Returns the names it deleted. */
export function cleanOldYtdlp(dir, pin = ytdlpPin()) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name === pin.name) continue;
    if (!/^yt-dlp([-_.].*)?$/i.test(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true, recursive: true });
      removed.push(name);
    } catch {
      /* in use or gone; never run anyway */
    }
  }
  return removed;
}

/* path → "sha256:size:mtimeMs:ctimeMs:ino" of the last file that matched. */
const verified = new Map();

/* ctime too: a program can set mtime back with utimes(), but not ctime. */
function stamp(st, pin) {
  return `${pin.sha256}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")));
  });
}

/* True when `file` is the pinned file. A file that does not match is
   deleted. An unchanged file (same size, mtime, inode) is not hashed again. */
export async function isVerified(file, pin = ytdlpPin()) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    verified.delete(file);
    return false;
  }
  if (st.isFile() && verified.get(file) === stamp(st, pin)) return true;
  const ok = st.isFile() && st.size === pin.size && (await sha256File(file)) === pin.sha256;
  if (ok) {
    verified.set(file, stamp(st, pin));
    return true;
  }
  verified.delete(file);
  fs.rmSync(file, { force: true, recursive: true });
  return false;
}

/* The pinned yt-dlp in `dir`, downloaded and checked when it is missing or
   does not match. The caller passes a persistent, writable dir (a cache dir
   in dev, the app's userData/bin in the packaged app). `opts` (tests only):
   pin, fetchImpl. */
export function ensureYtdlp(dir, opts = {}) {
  // One at a time per folder: a second call must not delete the first
  // call's partial download.
  const key = path.resolve(dir);
  const run = (inflight.get(key) ?? Promise.resolve()).catch(() => {}).then(() => ensureOnce(dir, opts));
  inflight.set(key, run);
  return run;
}

const inflight = new Map();

async function ensureOnce(dir, opts) {
  const pin = opts.pin ?? ytdlpPin();
  const fetchImpl = opts.fetchImpl ?? fetch;
  fs.mkdirSync(dir, { recursive: true });
  cleanOldYtdlp(dir, pin);
  const bin = path.join(dir, pin.name);
  if (await isVerified(bin, pin)) return bin;

  const res = await fetchImpl(pin.url, { headers: { "user-agent": "NitroAI" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't download yt-dlp ${pin.version} (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== pin.size || got !== pin.sha256) {
    throw new Error(`The yt-dlp ${pin.version} download did not match its SHA-256. Nothing was saved. Try again later.`);
  }
  const tmp = path.join(dir, `${pin.name}.${process.pid}.download`);
  fs.writeFileSync(tmp, bytes, { mode: 0o755 });
  fs.renameSync(tmp, bin);
  if (!(await isVerified(bin, pin))) throw new Error("yt-dlp changed on disk after the download.");
  return bin;
}

/* Strip WEBVTT headers/timing/markup to plain text, de-duplicating the rolling
   repeated lines auto-subs emit. */
export function vttToText(vtt) {
  const out = [];
  for (const raw of vtt.split("\n")) {
    const line = raw.trim();
    if (
      !line ||
      line === "WEBVTT" ||
      line.includes("-->") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:")
    ) {
      continue;
    }
    const text = line.replace(/<[^>]*>/g, "").trim();
    if (!text || out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.join(" ");
}

/* One yt-dlp run. The file is checked against the pin first (a changed file
   is deleted and refused), and the safe options always come first. */
async function runYtdlp(bin, pin, args, signal) {
  if (!(await isVerified(bin, pin))) {
    return { ok: false, stdout: "", stderr: "yt-dlp did not match its SHA-256 and was removed. Try again." };
  }
  try {
    const { stdout, stderr } = await execFileP(bin, [...YTDLP_SAFE_ARGS, ...args], {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "yt-dlp failed" };
  }
}

/* Extract a YouTube URL. Returns { transcript, audioBase64, audioExt, title }
   — the same shape the desktop Rust command returns, so the client handles
   both identically. `binDir` is where yt-dlp is cached/downloaded. `opts`
   (tests only): pin, fetchImpl. */
export async function extractYoutube(url, binDir, opts = {}) {
  const pin = opts.pin ?? ytdlpPin();
  const bin = await ensureYtdlp(binDir, opts);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `nitroai-yt-${createHash("sha1").update(url).digest("hex").slice(0, 8)}-`),
  );
  const outTmpl = path.join(dir, "%(id)s.%(ext)s");
  try {
    const titleRun = await runYtdlp(bin, pin, ["--no-warnings", "--print", "title", "--", url]);
    const title = titleRun.ok ? titleRun.stdout.trim() || null : null;

    // 1) captions (human + auto)
    await runYtdlp(bin, pin, [
      "--no-warnings", "--skip-download", "--write-auto-sub", "--write-sub",
      "--sub-langs", "en.*", "--sub-format", "vtt", "-o", outTmpl, "--", url,
    ]);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".vtt")) continue;
      const text = vttToText(fs.readFileSync(path.join(dir, entry), "utf8"));
      if (text.split(/\s+/).length > 5) {
        return { transcript: text, audioBase64: null, audioExt: null, title };
      }
    }

    // 2) audio fallback (Whisper accepts m4a/webm/mp3/wav/ogg)
    const audioRun = await runYtdlp(bin, pin, ["--no-warnings", "-f", "bestaudio", "-o", outTmpl, "--", url]);
    if (!audioRun.ok) throw new Error(`yt-dlp failed: ${audioRun.stderr.trim().slice(0, 400)}`);
    for (const entry of fs.readdirSync(dir)) {
      const ext = path.extname(entry).slice(1).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      const audio = fs.readFileSync(path.join(dir, entry));
      return { transcript: null, audioBase64: audio.toString("base64"), audioExt: ext, title };
    }
    throw new Error("yt-dlp couldn't get captions or audio for this video.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---- "Trim the solve-time gaps" (server/lecture.mjs) --------------------- */

/* The video file for a lecture: at most 720p (enough to read a board, and
   quick to cut), mp4 when YouTube has it. */
export const LECTURE_FORMAT =
  "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b";
export const LECTURE_MAX_SECONDS = 4 * 60 * 60;
const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000;
const VIDEO_EXTS = new Set(["mp4", "mkv", "webm", "mov", "m4v"]);

/* Download a YouTube video file and its English captions into `outDir` (the
   caller's own temp folder; the caller deletes it). The same rules as
   extractYoutube: the pinned, checked yt-dlp only, the safe options first,
   and the link as ONE argument after "--". No shell.
   Returns { videoPath, title, durationSeconds, vtt }; vtt is null when the
   video has no English captions.
   `opts`: ffmpegPath (yt-dlp joins the video and sound files with it),
   signal (stops the download), onProgress(0..1); tests only: pin, fetchImpl. */
export async function downloadLecture(url, binDir, outDir, opts = {}) {
  const { ffmpegPath, signal, onProgress } = opts;
  const pin = opts.pin ?? ytdlpPin();
  const bin = await ensureYtdlp(binDir, opts);
  const outTmpl = path.join(outDir, "video.%(ext)s");

  const info = await runYtdlp(bin, pin, ["--no-warnings", "--no-playlist", "--print", "title", "--print", "duration", "--", url], signal);
  signal?.throwIfAborted();
  if (!info.ok) throw new Error(`yt-dlp failed: ${info.stderr.trim().slice(0, 400)}`);
  const lines = info.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const durationSeconds = lines.length > 1 && Number.isFinite(Number(lines[lines.length - 1])) ? Number(lines[lines.length - 1]) : null;
  const title = lines[0] || null;
  if (durationSeconds !== null && durationSeconds > LECTURE_MAX_SECONDS) {
    throw new Error("This video is longer than 4 hours. NitroAI trims videos of up to 4 hours.");
  }

  // Captions: the times of the teacher's words. A failure here is not the
  // end: the video is then cut on silence alone.
  await runYtdlp(bin, pin, [
    "--no-warnings", "--no-playlist", "--skip-download", "--write-auto-sub", "--write-sub",
    "--sub-langs", "en.*", "--sub-format", "vtt", "-o", outTmpl, "--", url,
  ], signal);
  signal?.throwIfAborted();
  let vtt = null;
  for (const entry of fs.readdirSync(outDir).sort()) {
    if (!entry.endsWith(".vtt")) continue;
    const text = fs.readFileSync(path.join(outDir, entry), "utf8");
    if (vttToText(text).split(/\s+/).length > 5) {
      vtt = text;
      break;
    }
  }

  if (!(await isVerified(bin, pin))) throw new Error("yt-dlp did not match its SHA-256 and was removed. Try again.");
  const args = [
    ...YTDLP_SAFE_ARGS, "--no-warnings", "--no-playlist", "--newline", "--progress",
    "--progress-template", "download:nitro-progress %(progress._percent_str)s",
    "-f", LECTURE_FORMAT, "--merge-output-format", "mp4",
    ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
    "-o", outTmpl, "--", url,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal, timeout: DOWNLOAD_TIMEOUT_MS, windowsHide: true });
    let err = "";
    // yt-dlp counts 0-100% for the picture file, then again for the (small)
    // sound file. One line that only goes up: 90% picture, 10% sound.
    let files = 0;
    let lastPct = 0;
    child.stdout.setEncoding("utf8").on("data", (text) => {
      for (const m of text.matchAll(/nitro-progress\s+([\d.]+)%/g)) {
        const pct = Math.min(100, Number(m[1]));
        if (pct < lastPct) files += 1;
        lastPct = pct;
        onProgress?.(files === 0 ? (pct / 100) * 0.9 : Math.min(1, 0.9 + (pct / 100) * 0.1));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      err = (err + text).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp failed: ${err.trim().slice(0, 400) || `exit ${code}`}`));
    });
  });

  const video = fs
    .readdirSync(outDir)
    .find((name) => name.startsWith("video.") && VIDEO_EXTS.has(path.extname(name).slice(1).toLowerCase()));
  if (!video) throw new Error("yt-dlp did not save a video file for this link.");
  return { videoPath: path.join(outDir, video), title, durationSeconds, vtt };
}
