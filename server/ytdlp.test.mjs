/* yt-dlp input validation: only YouTube video URLs/ids reach the binary, in
 * canonical form, always after "--" so nothing can be read as an option. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const calls = vi.hoisted(() => []);

vi.mock("node:child_process", () => ({
  execFile: (bin, args, opts, cb) => {
    calls.push(args);
    if (args.includes("bestaudio")) {
      const tmpl = args[args.indexOf("-o") + 1];
      fs.writeFileSync(path.join(path.dirname(tmpl), "dQw4w9WgXcQ.m4a"), "audio");
    }
    cb(null, { stdout: "A title\n", stderr: "" });
  },
}));

const { canonicalYoutubeUrl, extractYoutube } = await import("./ytdlp.mjs");

describe("canonicalYoutubeUrl", () => {
  const C = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  it.each([
    "dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123",
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
    "youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "  https://youtu.be/dQw4w9WgXcQ  ",
  ])("accepts %s", (u) => expect(canonicalYoutubeUrl(u)).toBe(C));

  it.each([
    "--exec=touch /tmp/pwned",
    "-o/etc/passwd",
    "--config-location=/tmp/x",
    "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/watch?v=short",
    "https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
    "file:///etc/passwd",
    "http://169.254.169.254/",
    "",
    null,
  ])("rejects %s", (u) => expect(canonicalYoutubeUrl(u)).toBeNull());
});

describe("extractYoutube", () => {
  let binDir;
  beforeEach(() => {
    calls.length = 0;
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-ytbin-"));
    // Pretend yt-dlp is already downloaded so nothing touches the network.
    fs.writeFileSync(path.join(binDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"), "");
  });
  afterEach(() => fs.rmSync(binDir, { recursive: true, force: true }));

  it("refuses invalid input without running yt-dlp", async () => {
    await expect(extractYoutube("--exec=id", binDir)).rejects.toMatchObject({ code: "invalid_youtube_url" });
    await expect(extractYoutube("https://example.com/", binDir)).rejects.toMatchObject({ code: "invalid_youtube_url" });
    expect(calls).toHaveLength(0);
  });

  it("passes only the canonical URL, always after --", async () => {
    const r = await extractYoutube("https://youtu.be/dQw4w9WgXcQ?si=x", binDir);
    expect(r.audioExt).toBe("m4a");
    expect(calls.length).toBe(3);
    for (const args of calls) {
      expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(args.at(-2)).toBe("--");
    }
  });
});
