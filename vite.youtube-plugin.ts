/* Local YouTube extraction for the browser build.
 *
 * YouTube's PoToken/BotGuard gate returns empty captions to any in-browser
 * fetch, so the SPA alone can't ingest YouTube links. The desktop app solves
 * this with a Rust `youtube_extract` command running yt-dlp. This plugin gives
 * `vite dev` / `vite preview` the exact same capability from the local Node
 * process: GET /api/youtube-extract?url=… → { transcript, audioBase64,
 * audioExt, title } — the same shape the Rust command returns, captions first,
 * audio fallback, yt-dlp auto-downloaded on first use so nothing is installed
 * by hand. Only a purely static deployment is left without a YouTube path.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Connect, Plugin } from "vite";
import type { ServerResponse } from "node:http";

const execFileP = promisify(execFile);

const CACHE_DIR = path.join(process.cwd(), "node_modules", ".cache", "nitroai");
const RUN_TIMEOUT_MS = 300_000;

function ytdlpAsset(): string {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp";
}

/* Mirror of the Rust ensure_ytdlp: download the official standalone build once
   into a cache dir; the user never installs anything by hand. */
async function ensureYtdlp(): Promise<string> {
  const bin = path.join(CACHE_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset()}`;
  const res = await fetch(url, { headers: { "user-agent": "NitroAI" } });
  if (!res.ok) throw new Error(`Couldn't download yt-dlp (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(bin, bytes);
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  return bin;
}

/* Same semantics as the Rust vtt_to_text: strip WEBVTT headers/timing/markup,
   de-duplicate the rolling repeated lines that auto-subs emit. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
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

async function runYtdlp(bin: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "yt-dlp failed" };
  }
}

const AUDIO_EXTS = new Set(["m4a", "webm", "mp3", "opus", "wav", "mp4", "aac", "ogg"]);

interface ExtractResult {
  transcript: string | null;
  audioBase64: string | null;
  audioExt: string | null;
  title: string | null;
}

async function extract(url: string): Promise<ExtractResult> {
  const bin = await ensureYtdlp();
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `nitroai-yt-${createHash("sha1").update(url).digest("hex").slice(0, 8)}-`),
  );
  const outTmpl = path.join(dir, "%(id)s.%(ext)s");

  try {
    const titleRun = await runYtdlp(bin, ["--no-warnings", "--print", "title", url]);
    const title = titleRun.ok ? titleRun.stdout.trim() || null : null;

    // 1) captions (human + auto)
    await runYtdlp(bin, [
      "--no-warnings",
      "--skip-download",
      "--write-auto-sub",
      "--write-sub",
      "--sub-langs",
      "en.*",
      "--sub-format",
      "vtt",
      "-o",
      outTmpl,
      url,
    ]);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".vtt")) continue;
      const text = vttToText(fs.readFileSync(path.join(dir, entry), "utf8"));
      if (text.split(/\s+/).length > 5) {
        return { transcript: text, audioBase64: null, audioExt: null, title };
      }
    }

    // 2) audio fallback (native container; Whisper accepts m4a/webm/mp3/wav/ogg)
    const audioRun = await runYtdlp(bin, ["--no-warnings", "-f", "bestaudio", "-o", outTmpl, url]);
    if (!audioRun.ok) {
      throw new Error(`yt-dlp failed: ${audioRun.stderr.trim().slice(0, 400)}`);
    }
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

function middleware(): Connect.NextHandleFunction {
  return (req, res: ServerResponse, next) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname !== "/api/youtube-extract") return next();
    const target = reqUrl.searchParams.get("url");

    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
    };

    if (!target) return send(400, { error: "missing url parameter" });
    extract(target)
      .then((result) => send(200, result))
      .catch((err: unknown) =>
        send(502, { error: err instanceof Error ? err.message : "extraction failed" }),
      );
  };
}

export function youtubeExtractPlugin(): Plugin {
  return {
    name: "nitroai-youtube-extract",
    configureServer(server) {
      server.middlewares.use(middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware());
    },
  };
}
