/* Shared yt-dlp extraction — used by BOTH the vite dev/preview plugin
 * (vite.youtube-plugin.ts) and the packaged Electron shell's local server
 * (server/httpServer.mjs). YouTube's PoToken/BotGuard gate empties in-browser
 * caption fetches, so the only reliable free path is a local yt-dlp process:
 * captions first, audio fallback for Whisper. yt-dlp is auto-downloaded on
 * first use so a non-technical user installs nothing by hand.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const RUN_TIMEOUT_MS = 300_000;
const AUDIO_EXTS = new Set(["m4a", "webm", "mp3", "opus", "wav", "mp4", "aac", "ogg"]);

function ytdlpAsset() {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp";
}

/* Download the official standalone yt-dlp build once into `dir`; return its
   path. The caller passes a persistent, writable dir (a cache dir in dev, the
   app's userData/bin in the packaged app). */
export async function ensureYtdlp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (fs.existsSync(bin)) return bin;
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset()}`;
  const res = await fetch(url, { headers: { "user-agent": "NitroAI" } });
  if (!res.ok) throw new Error(`Couldn't download yt-dlp (${res.status})`);
  fs.writeFileSync(bin, Buffer.from(await res.arrayBuffer()));
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
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

async function runYtdlp(bin, args) {
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "yt-dlp failed" };
  }
}

/* Extract a YouTube URL. Returns { transcript, audioBase64, audioExt, title }
   — the same shape the desktop Rust command returns, so the client handles
   both identically. `binDir` is where yt-dlp is cached/downloaded. */
export async function extractYoutube(url, binDir) {
  const bin = await ensureYtdlp(binDir);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `nitroai-yt-${createHash("sha1").update(url).digest("hex").slice(0, 8)}-`),
  );
  const outTmpl = path.join(dir, "%(id)s.%(ext)s");
  try {
    const titleRun = await runYtdlp(bin, ["--no-warnings", "--print", "title", url]);
    const title = titleRun.ok ? titleRun.stdout.trim() || null : null;

    // 1) captions (human + auto)
    await runYtdlp(bin, [
      "--no-warnings", "--skip-download", "--write-auto-sub", "--write-sub",
      "--sub-langs", "en.*", "--sub-format", "vtt", "-o", outTmpl, url,
    ]);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".vtt")) continue;
      const text = vttToText(fs.readFileSync(path.join(dir, entry), "utf8"));
      if (text.split(/\s+/).length > 5) {
        return { transcript: text, audioBase64: null, audioExt: null, title };
      }
    }

    // 2) audio fallback (Whisper accepts m4a/webm/mp3/wav/ogg)
    const audioRun = await runYtdlp(bin, ["--no-warnings", "-f", "bestaudio", "-o", outTmpl, url]);
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
