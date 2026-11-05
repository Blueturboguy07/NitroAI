/* Round 7: yt-dlp hardening. In v0.2.1 and v0.2.2 any web page could give
 * yt-dlp one argument (for example --update-to=<repo>@<tag>), which can
 * replace the cached userData/bin/yt-dlp with another file. A version that
 * reuses that file keeps running it. Now one release is pinned by SHA-256,
 * kept at bin/yt-dlp-<version>, checked before every run, and run with
 * --ignore-config --no-update and "--" before the link.
 *
 * The "yt-dlp" here is a small shell script (its SHA-256 is the test pin),
 * served by a stand-in for fetch. The old bin/yt-dlp in each test is a
 * script that leaves a marker file when it runs. No test downloads anything
 * (fetch is stubbed), before or after the fix. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("./ytdlp.mjs");
const URL_ = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

let dir;
let fetchCalls;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-ytdlp-"));
  fetchCalls = [];
  // Nothing in this file may reach the network, on the fix or on 441a603.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u) => {
      fetchCalls.push(String(u));
      throw new Error("network is off in this test");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* The stand-in yt-dlp: logs its arguments, prints a title, writes a caption
   file next to the -o template. */
function fakeYtdlp(argLog, marker = "") {
  return Buffer.from(
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${argLog}'`,
      marker ? `echo ran > '${marker}'` : "",
      'out=""; prev=""; title=0',
      'for a in "$@"; do',
      '  [ "$prev" = "-o" ] && out="$a"',
      '  [ "$prev" = "--print" ] && [ "$a" = "title" ] && title=1',
      '  prev="$a"',
      "done",
      'if [ "$title" = 1 ]; then echo "Pinned Title"; exit 0; fi',
      `if [ -n "$out" ]; then printf 'WEBVTT\\n\\n00:00.000 --> 00:01.000\\nthe pinned yt-dlp wrote these captions here\\n' > "$(dirname "$out")/v.en.vtt"; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
}

/* A pin for the stand-in, and a fetch that serves it at the pin's URL only. */
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
function serving(bytes, pin) {
  return vi.fn(async (u) => {
    fetchCalls.push(String(u));
    if (String(u) !== pin.url) throw new Error(`unexpected download ${u}`);
    return new Response(bytes, { status: 200 });
  });
}

/* The v0.2.2 file: bin/yt-dlp. Running it leaves `marker` (and logs its
   arguments to `argLog`, when given). */
function plantOld(marker, argLog) {
  const old = path.join(dir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const logLine = argLog ? `printf '%s\\n' "$*" >> '${argLog}'\n` : "";
  fs.writeFileSync(old, `#!/bin/sh\n${logLine}echo ran > '${marker}'\necho "Attacker Title"\nexit 0\n`, { mode: 0o755 });
  return old;
}

const args = (log) => fs.readFileSync(log, "utf8").trim().split("\n");

describe.skipIf(process.platform === "win32")("yt-dlp: pinned, checked, and run with safe options (round 7)", () => {
  it("an existing old bin/yt-dlp is never run; it is deleted and the pinned file is downloaded", async () => {
    const marker = path.join(dir, "OLD-RAN");
    const old = plantOld(marker);
    const log = path.join(dir, "args.log");
    const bytes = fakeYtdlp(log);
    const pin = pinFor(bytes);
    const fetchImpl = serving(bytes, pin);
    const r = await mod.extractYoutube(URL_, dir, { pin, fetchImpl }).catch((e) => e);
    expect(fs.existsSync(marker)).toBe(false); // the old file never ran
    expect(fs.existsSync(old)).toBe(false); // and it is gone
    expect(r).toMatchObject({ transcript: "the pinned yt-dlp wrote these captions here", title: "Pinned Title" });
    expect(fetchCalls).toEqual([pin.url]);
    expect(fs.existsSync(path.join(dir, "yt-dlp-test"))).toBe(true);
  });

  it("the server deletes the old bin/yt-dlp (and other versions) at startup", async () => {
    const marker = path.join(dir, "OLD-RAN");
    const old = plantOld(marker);
    fs.writeFileSync(path.join(dir, "yt-dlp-2025.01.01"), "older pinned version");
    fs.writeFileSync(path.join(dir, "ollama"), "not ours to touch");
    const { startServer } = await import("./httpServer.mjs");
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html></html>");
    const app = await startServer({ distDir: path.join(dir, "dist"), binDir: dir, port: 0 });
    try {
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(path.join(dir, "yt-dlp-2025.01.01"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "ollama"))).toBe(true);
    } finally {
      await new Promise((r) => app.server.close(r));
    }
  });

  it("a pinned file with the wrong SHA-256 is deleted and downloaded again before it runs", async () => {
    const marker = path.join(dir, "OLD-RAN");
    plantOld(marker); // on 441a603 this file would run; it must not
    const log = path.join(dir, "args.log");
    const bytes = fakeYtdlp(log);
    const pin = pinFor(bytes);
    const badMarker = path.join(dir, "BAD-RAN");
    fs.writeFileSync(path.join(dir, pin.name), `#!/bin/sh\necho ran > '${badMarker}'\n`, { mode: 0o755 });
    const r = await mod.extractYoutube(URL_, dir, { pin, fetchImpl: serving(bytes, pin) }).catch((e) => e);
    expect(fs.existsSync(badMarker)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fetchCalls).toEqual([pin.url]);
    expect(createHash("sha256").update(fs.readFileSync(path.join(dir, pin.name))).digest("hex")).toBe(pin.sha256);
    expect(r).toMatchObject({ transcript: "the pinned yt-dlp wrote these captions here" });
  });

  it("the hash is checked before every run: a file changed after the download never runs, and is fetched again", async () => {
    const marker = path.join(dir, "OLD-RAN");
    plantOld(marker);
    const log = path.join(dir, "args.log");
    const bytes = fakeYtdlp(log);
    const pin = pinFor(bytes);
    const fetchImpl = serving(bytes, pin);
    await mod.extractYoutube(URL_, dir, { pin, fetchImpl }).catch(() => {});
    // Something replaces the checked file (same name, same size).
    const swapMarker = path.join(dir, "SWAP-RAN");
    let swapped = `#!/bin/sh\necho ran > '${swapMarker}'\n#`;
    swapped += "x".repeat(bytes.length - Buffer.byteLength(swapped));
    fs.writeFileSync(path.join(dir, pin.name), swapped, { mode: 0o755 });
    const r = await mod.extractYoutube(URL_, dir, { pin, fetchImpl }).catch((e) => e);
    expect(fs.existsSync(swapMarker)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fetchCalls).toEqual([pin.url, pin.url]);
    expect(r).toMatchObject({ transcript: "the pinned yt-dlp wrote these captions here" });
  });

  it("a download that does not match the pin is refused, and nothing is saved or run", async () => {
    const marker = path.join(dir, "OLD-RAN");
    plantOld(marker);
    const log = path.join(dir, "args.log");
    const bytes = fakeYtdlp(log);
    const pin = pinFor(bytes);
    const other = fakeYtdlp(path.join(dir, "other.log"));
    const r = await mod.extractYoutube(URL_, dir, { pin, fetchImpl: serving(other, pin) }).catch((e) => e);
    expect(r).toBeInstanceOf(Error);
    expect(String(r.message)).toMatch(/did not match its SHA-256/);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("yt-dlp"))).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(dir, "other.log"))).toBe(false);
  });

  it("every run starts with --ignore-config --no-update, and the link comes right after \"--\"", async () => {
    const marker = path.join(dir, "OLD-RAN");
    const log = path.join(dir, "args.log");
    plantOld(marker, log); // on 441a603 this file runs and logs the old arguments
    const bytes = fakeYtdlp(log);
    const pin = pinFor(bytes);
    // A link that looks like an option is still only a link.
    const hostile = "--update-to=attacker/yt-dlp@evil";
    await mod.extractYoutube(hostile, dir, { pin, fetchImpl: serving(bytes, pin) }).catch(() => {});
    await mod.extractYoutube(URL_, dir, { pin, fetchImpl: serving(bytes, pin) }).catch(() => {});
    const runs = fs.existsSync(log) ? args(log) : [];
    for (const line of runs) {
      expect(line.startsWith("--ignore-config --no-update "), line).toBe(true);
      expect(line.endsWith(`-- ${hostile}`) || line.endsWith(`-- ${URL_}`), line).toBe(true);
    }
    expect(runs.some((l) => l.endsWith(`-- ${hostile}`))).toBe(true);
    expect(runs.length).toBeGreaterThanOrEqual(4); // title + captions, twice
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("an unchanged checked file is hashed once, not before each of its runs", async () => {
    const marker = path.join(dir, "OLD-RAN");
    plantOld(marker);
    const log = path.join(dir, "args.log");
    const bytes = fakeYtdlp(log);
    const pin = pinFor(bytes);
    const fetchImpl = serving(bytes, pin);
    await mod.extractYoutube(URL_, dir, { pin, fetchImpl });
    const spy = vi.spyOn(fs, "createReadStream");
    try {
      await mod.extractYoutube(URL_, dir, { pin, fetchImpl });
      expect(spy.mock.calls.filter(([f]) => String(f).endsWith(pin.name))).toHaveLength(0);
      // A touched file (new mtime/ctime) is hashed again.
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(dir, pin.name), t, t);
      await mod.extractYoutube(URL_, dir, { pin, fetchImpl });
      expect(spy.mock.calls.filter(([f]) => String(f).endsWith(pin.name))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect(fetchCalls).toEqual([pin.url]);
  });
});

describe("yt-dlp: the real pin (round 7)", () => {
  it("is one release, by version, never 'latest'; every platform has a SHA-256 and a size", async () => {
    expect(mod.YTDLP_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
    const src = fs.readFileSync(new URL("./ytdlp.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/releases\/latest/);
    for (const [key, f] of Object.entries(mod.YTDLP_FILES)) {
      expect(f.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(f.size, key).toBeGreaterThan(1_000_000);
    }
    for (const [platform, arch, asset, name] of [
      ["darwin", "arm64", "yt-dlp_macos", `yt-dlp-${mod.YTDLP_VERSION}`],
      ["darwin", "x64", "yt-dlp_macos", `yt-dlp-${mod.YTDLP_VERSION}`],
      ["win32", "x64", "yt-dlp.exe", `yt-dlp-${mod.YTDLP_VERSION}.exe`],
      ["linux", "x64", "yt-dlp_linux", `yt-dlp-${mod.YTDLP_VERSION}`],
    ]) {
      const pin = mod.ytdlpPin(platform, arch);
      expect(pin).toMatchObject({ asset, name, version: mod.YTDLP_VERSION });
      expect(pin.url).toBe(`https://github.com/yt-dlp/yt-dlp/releases/download/${mod.YTDLP_VERSION}/${asset}`);
    }
    expect(mod.YTDLP_SAFE_ARGS).toEqual(["--ignore-config", "--no-update"]);
  });
});
