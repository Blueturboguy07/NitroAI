/* Security guards on the local server: who may call /api/* (Host, Origin,
 * Sec-Fetch-Site, X-NitroAI), malformed/traversal static paths, the
 * /api/fetch-page SSRF guard, and yt-dlp input validation at the route. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { startServer } from "./httpServer.mjs";
import { checkApiRequest, isAllowedHost } from "./requestGuard.mjs";
import { fetchPage, isPrivateAddress, validateTargetUrl } from "./fetchPage.mjs";

/* Raw request so tests control Host/Origin exactly (fetch would set them). */
function raw(port, { method = "GET", path: p = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, setHost: false, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const json = (r) => JSON.parse(r.body);

/* ---------- requestGuard unit ---------- */

describe("checkApiRequest", () => {
  const req = (headers) => ({ headers: { host: "127.0.0.1:41763", ...headers } });

  it("accepts the app's own calls", () => {
    expect(checkApiRequest(req({ "x-nitroai": "1" }), "/api/local/status")).toBeNull();
    expect(
      checkApiRequest(req({ "x-nitroai": "1", origin: "http://127.0.0.1:41763", "sec-fetch-site": "same-origin" }), "/api/publik/forget"),
    ).toBeNull();
    expect(checkApiRequest({ headers: { host: "localhost:1420", "x-nitroai": "1", origin: "http://localhost:1420" } }, "/api/fetch-page")).toBeNull();
    expect(checkApiRequest({ headers: { host: "[::1]:5", "x-nitroai": "1" } }, "/api/fetch-page")).toBeNull();
  });

  it("refuses non-loopback Host (DNS rebinding) even with the header", () => {
    expect(checkApiRequest({ headers: { host: "evil.example:41763", "x-nitroai": "1" } }, "/api/health")?.error).toBe("forbidden_host");
    expect(checkApiRequest({ headers: { "x-nitroai": "1" } }, "/api/health")?.error).toBe("forbidden_host");
    expect(checkApiRequest({ headers: { host: "127.0.0.1.evil.example", "x-nitroai": "1" } }, "/api/health")?.error).toBe("forbidden_host");
  });

  it("refuses a foreign Origin, null Origin, or cross-site Sec-Fetch-Site", () => {
    expect(checkApiRequest(req({ "x-nitroai": "1", origin: "https://evil.example" }), "/api/publik/disconnect")?.error).toBe("forbidden_origin");
    expect(checkApiRequest(req({ "x-nitroai": "1", origin: "null" }), "/api/publik/disconnect")?.error).toBe("forbidden_origin");
    expect(checkApiRequest(req({ "x-nitroai": "1", origin: "http://127.0.0.1:9999" }), "/api/local/setup")?.error).toBe("forbidden_origin");
    expect(checkApiRequest(req({ "x-nitroai": "1", "sec-fetch-site": "cross-site" }), "/api/local/setup")?.error).toBe("forbidden_origin");
    expect(checkApiRequest(req({ "x-nitroai": "1", "sec-fetch-site": "same-site" }), "/api/local/setup")?.error).toBe("forbidden_origin");
  });

  it("requires X-NitroAI except on health; the OpenAI passthrough accepts a same-origin signal instead", () => {
    expect(checkApiRequest(req({}), "/api/local/setup")?.error).toBe("missing_client_header");
    expect(checkApiRequest(req({ "x-nitroai": "0" }), "/api/youtube-extract")?.error).toBe("missing_client_header");
    expect(checkApiRequest(req({}), "/api/health")).toBeNull();
    expect(checkApiRequest(req({ origin: "http://127.0.0.1:41763" }), "/api/publik/v1/chat/completions")).toBeNull();
    expect(checkApiRequest(req({ "sec-fetch-site": "same-origin" }), "/api/publik/v1/models")).toBeNull();
    expect(checkApiRequest(req({}), "/api/publik/v1/models")?.error).toBe("missing_client_header");
    // ...but the passthrough exception doesn't extend to the credential routes
    expect(checkApiRequest(req({ origin: "http://127.0.0.1:41763" }), "/api/publik/provision")?.error).toBe("missing_client_header");
  });

  it("isAllowedHost honours explicit extra dev hosts only", () => {
    expect(isAllowedHost("192.168.1.20:1420")).toBe(false);
    expect(isAllowedHost("192.168.1.20:1420", ["192.168.1.20"])).toBe(true);
    expect(isAllowedHost("192.168.1.20:1420", [undefined])).toBe(false);
  });
});

/* ---------- server: guards on real routes + static path handling ---------- */

describe("local server guards", () => {
  let dir;
  let app;
  let port;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-sec-"));
    fs.mkdirSync(path.join(dir, "dist", "pdfjs", "wasm"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
    fs.writeFileSync(path.join(dir, "dist", "pdfjs", "wasm", "openjpeg.wasm"), "\0asm");
    fs.mkdirSync(path.join(dir, "dist-evil"));
    fs.writeFileSync(path.join(dir, "dist-evil", "secret.txt"), "SECRET");
    app = await startServer({
      distDir: path.join(dir, "dist"),
      binDir: path.join(dir, "bin"),
      port: 0,
      publik: { token: null, credentialFile: path.join(dir, "publik.json"), baseUrl: "http://127.0.0.1:9" },
    });
    port = app.port;
  });
  afterEach(async () => {
    await new Promise((r) => app?.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a cross-site page can't disconnect/forget/provision publik or start local setup", async () => {
    for (const p of ["/api/publik/disconnect", "/api/publik/forget", "/api/publik/provision", "/api/local/setup"]) {
      // A form POST / no-cors fetch from another site: foreign Origin, no header.
      const r = await raw(port, { method: "POST", path: p, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
      expect(r.status, p).toBe(403);
      // Even if it somehow had the header, the Origin still fails.
      const r2 = await raw(port, { method: "POST", path: p, headers: { origin: "https://evil.example", "x-nitroai": "1" } });
      expect(r2.status, p).toBe(403);
      // And with no Origin at all, the missing header fails it.
      const r3 = await raw(port, { method: "POST", path: p });
      expect(r3.status, p).toBe(403);
      expect(json(r3).error).toBe("missing_client_header");
    }
  });

  it("DNS rebinding: a foreign Host header is refused on every API route", async () => {
    for (const p of ["/api/health", "/api/local/status", "/api/publik/status", "/api/fetch-page?url=https://example.com/"]) {
      const r = await raw(port, { path: p, headers: { host: `rebind.evil.example:${port}`, "x-nitroai": "1" } });
      expect(r.status, p).toBe(403);
      expect(json(r).error).toBe("forbidden_host");
    }
  });

  it("mutating endpoints are POST-only (405 on GET, nothing started)", async () => {
    const setup = await raw(port, { path: "/api/local/setup", headers: { "x-nitroai": "1" } });
    expect(setup.status).toBe(405);
    expect(setup.headers.allow).toBe("POST");
    for (const p of ["/api/publik/disconnect", "/api/publik/forget", "/api/publik/provision"]) {
      expect((await raw(port, { path: p, headers: { "x-nitroai": "1" } })).status, p).toBe(405);
    }
    expect((await raw(port, { path: "/api/youtube-extract?url=dQw4w9WgXcQ", headers: { "x-nitroai": "1" } })).status).toBe(405);
  });

  it("the app's own calls get through; health needs no header", async () => {
    const s = await raw(port, {
      path: "/api/publik/status",
      headers: { "x-nitroai": "1", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
    });
    expect(s.status).toBe(200);
    expect((await raw(port, { path: "/api/health" })).status).toBe(200);
    // The OpenAI client's passthrough call (same Origin, no custom header) reaches the proxy.
    const chat = await raw(port, { method: "POST", path: "/api/publik/chat", headers: { origin: `http://127.0.0.1:${port}` } });
    expect(chat.status).toBe(401); // no credential — but NOT a 403 from the guard
  });

  it("static files (incl. pdf.js data) are served without API headers", async () => {
    const w = await raw(port, { path: "/pdfjs/wasm/openjpeg.wasm" });
    expect(w.status).toBe(200);
    expect(w.headers["content-type"]).toBe("application/wasm");
    expect((await raw(port, { path: "/notes/1/editor" })).body).toContain("app");
  });

  it("a malformed %-escape answers 400 and the server keeps running", async () => {
    expect((await raw(port, { path: "/%E0%A4%A" })).status).toBe(400);
    expect((await raw(port, { path: "/%" })).status).toBe(400);
    expect((await raw(port, { path: "/%00" })).status).toBe(400);
    expect((await raw(port, { path: "/api/health" })).status).toBe(200);
  });

  it("path traversal can't escape dist/, including into a sibling sharing its prefix", async () => {
    const sib = await raw(port, { path: "/..%2fdist-evil%2fsecret.txt" });
    expect(sib.status).toBe(403);
    expect(sib.body).not.toContain("SECRET");
    expect((await raw(port, { path: "/..%2f..%2f..%2fetc%2fpasswd" })).status).toBe(403);
  });

  it("youtube-extract refuses non-YouTube input before running yt-dlp", async () => {
    for (const u of ["--exec=touch /tmp/pwned", "https://evil.example/watch?v=dQw4w9WgXcQ", "file:///etc/passwd", "http://169.254.169.254/"]) {
      const r = await raw(port, { method: "POST", path: `/api/youtube-extract?url=${encodeURIComponent(u)}`, headers: { "x-nitroai": "1" } });
      expect(r.status, u).toBe(400);
    }
    expect(fs.existsSync(path.join(dir, "bin"))).toBe(false); // yt-dlp was never even downloaded
  });

  it("fetch-page refuses loopback/private/non-http targets", async () => {
    const cases = [
      [`http://127.0.0.1:${port}/api/health`, 403],
      ["http://localhost/", 403],
      ["http://[::1]/", 403],
      ["http://169.254.169.254/latest/meta-data/", 403],
      ["http://10.0.0.1/", 403],
      ["http://[::ffff:127.0.0.1]/", 403],
      ["http://0x7f000001/", 403],
      ["http://2130706433/", 403],
      ["file:///etc/passwd", 400],
      ["ftp://example.com/", 400],
      ["javascript:alert(1)", 400],
      ["not a url", 400],
    ];
    for (const [u, status] of cases) {
      const r = await raw(port, { path: `/api/fetch-page?url=${encodeURIComponent(u)}`, headers: { "x-nitroai": "1" } });
      expect(r.status, u).toBe(status);
    }
    expect((await raw(port, { path: "/api/fetch-page", headers: { "x-nitroai": "1" } })).status).toBe(400);
    expect((await raw(port, { path: "/api/fetch-page?url=https://example.com/" })).status).toBe(403); // no header
  });
});

/* ---------- fetch-page SSRF guard ---------- */

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fe80::1%en0", "fd00::1",
    "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::", "[::1]", "not-an-ip", "",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.215.14", "1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::"])(
    "allows %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("validateTargetUrl", () => {
  it("accepts http/https public hosts and strips the fragment", () => {
    expect(validateTargetUrl("https://example.com/a#frag").href).toBe("https://example.com/a");
  });
  it("rejects other schemes and loopback names", () => {
    expect(() => validateTargetUrl("data:text/html,hi")).toThrow(/http/);
    expect(() => validateTargetUrl("http://foo.localhost/")).toThrow(/private/);
  });
});

describe("fetchPage", () => {
  const site = { server: null, port: 0, route: null };
  // In these tests the fake site lives on 127.0.0.1, so loopback must be
  // allowed for it specifically; every other private address stays blocked.
  const allowLoopback = (ip) => ip !== "127.0.0.1" && isPrivateAddress(ip);
  const resolveTo = (map) => async (host) => {
    if (!(host in map)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return map[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

  beforeAll(async () => {
    site.server = http.createServer((req, res) => site.route(req, res));
    await new Promise((r) => site.server.listen(0, "127.0.0.1", r));
    site.port = site.server.address().port;
  });
  afterAll(() => {
    site.server.closeAllConnections?.();
    site.server.close();
  });

  it("fetches through the vetted DNS answer, decompresses and decodes", async () => {
    site.route = (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(zlib.gzipSync("<html><title>Hi</title><body>héllo</body></html>"));
    };
    const r = await fetchPage(`http://page.test:${site.port}/x`, {
      resolve: resolveTo({ "page.test": ["127.0.0.1"] }),
      isBlockedAddress: allowLoopback,
    });
    expect(r.html).toContain("héllo");
    expect(r.finalUrl).toBe(`http://page.test:${site.port}/x`);
  });

  it("refuses a hostname whose DNS answer is private — before connecting", async () => {
    let hit = false;
    site.route = (req, res) => {
      hit = true;
      res.end("x");
    };
    await expect(
      fetchPage(`http://internal.test:${site.port}/`, { resolve: resolveTo({ "internal.test": ["127.0.0.1"] }) }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    await expect(
      fetchPage("http://mixed.test/", { resolve: resolveTo({ "mixed.test": ["93.184.215.14", "10.0.0.7"] }) }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    expect(hit).toBe(false);
  });

  it("re-checks every redirect hop (IP literal and hostname targets)", async () => {
    site.route = (req, res) => {
      const to = req.url === "/to-literal" ? "http://169.254.169.254/latest/meta-data/" : "http://intranet.test/admin";
      res.writeHead(302, { location: to });
      res.end();
    };
    const opts = { resolve: resolveTo({ "page.test": ["127.0.0.1"], "intranet.test": ["192.168.1.1"] }), isBlockedAddress: allowLoopback };
    await expect(fetchPage(`http://page.test:${site.port}/to-literal`, opts)).rejects.toMatchObject({ code: "blocked_address" });
    await expect(fetchPage(`http://page.test:${site.port}/to-name`, opts)).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("refuses redirects to non-http schemes and stops redirect loops", async () => {
    site.route = (req, res) => {
      res.writeHead(302, { location: req.url === "/file" ? "file:///etc/passwd" : "/loop" });
      res.end();
    };
    const opts = { resolve: resolveTo({ "page.test": ["127.0.0.1"] }), isBlockedAddress: allowLoopback };
    await expect(fetchPage(`http://page.test:${site.port}/file`, opts)).rejects.toMatchObject({ code: "invalid_url" });
    await expect(fetchPage(`http://page.test:${site.port}/loop`, opts)).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("caps the body size (declared and streamed) and the total time", async () => {
    const opts = { resolve: resolveTo({ "page.test": ["127.0.0.1"] }), isBlockedAddress: allowLoopback, maxBytes: 1000 };
    site.route = (req, res) => {
      if (req.url === "/declared") {
        res.writeHead(200, { "content-type": "text/html", "content-length": "5000" });
        return res.end("x".repeat(5000));
      }
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/html" }); // chunked, no length
        res.write("x".repeat(800));
        return setTimeout(() => res.end("x".repeat(800)), 10);
      }
      // /hang: never answers
    };
    await expect(fetchPage(`http://page.test:${site.port}/declared`, opts)).rejects.toMatchObject({ code: "too_large" });
    await expect(fetchPage(`http://page.test:${site.port}/stream`, opts)).rejects.toMatchObject({ code: "too_large" });
    await expect(fetchPage(`http://page.test:${site.port}/hang`, { ...opts, timeoutMs: 200 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports non-HTML content and HTTP errors honestly", async () => {
    const opts = { resolve: resolveTo({ "page.test": ["127.0.0.1"] }), isBlockedAddress: allowLoopback };
    site.route = (req, res) => {
      if (req.url === "/pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        return res.end("%PDF");
      }
      res.writeHead(404, { "content-type": "text/html" });
      res.end("nope");
    };
    await expect(fetchPage(`http://page.test:${site.port}/pdf`, opts)).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(fetchPage(`http://page.test:${site.port}/missing`, opts)).rejects.toMatchObject({
      code: "upstream_status",
      upstreamStatus: 404,
    });
    await expect(fetchPage("http://nowhere.test/", { resolve: resolveTo({}) })).rejects.toMatchObject({ code: "dns" });
  });
});
