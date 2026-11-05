/* Round 5, item 3: Website links failed with "Failed to fetch" on most real
 * sites (en.wikipedia.org too): the renderer's fetch() is cross-origin from
 * http://127.0.0.1:<port> and the sites send no CORS header for it. The
 * local server now downloads the page (GET /api/fetch-page).
 *
 * Round 6, item 2 (SSRF): the route followed links and redirects to
 * 127.0.0.1, localhost, 0.0.0.0, the app's own /api routes, 169.254.169.254
 * and private ranges. Now every address is checked, before the first
 * request and after every redirect, inside the socket's own DNS lookup.
 *
 * The fake site runs on 127.0.0.1, which is now blocked. So the tests call
 * it "site.test", resolve that name with a stand-in for dns.lookup, and name
 * "site.test:<port>" in allowHosts (a test-only hook that skips the address
 * check for that one host and port). Every other host is checked as in the
 * app. No test makes a connection off this machine. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { startServer } from "./httpServer.mjs";

const site = { server: null, port: 0, url: "", requests: [], route: null };

beforeAll(async () => {
  site.server = http.createServer((req, res) => {
    site.requests.push({ url: req.url, headers: req.headers, remote: req.socket.remoteAddress });
    site.route(req, res);
  });
  await new Promise((r) => site.server.listen(0, "127.0.0.1", r));
  site.port = site.server.address().port;
  site.url = `http://site.test:${site.port}`;
});
afterAll(() => site.server.close());

const ARTICLE = "<html><head><title>Photosynthesis</title></head><body><p>Plants fix CO2.</p></body></html>";

/* Where /go?to=<url> sends the reader. */
let redirectTarget = "";

function defaultRoute(req, res) {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/wiki/Photosynthesis") {
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    return res.end(ARTICLE);
  }
  if (u.pathname === "/moved") {
    res.writeHead(301, { location: "/wiki/Photosynthesis" });
    return res.end();
  }
  if (u.pathname === "/go") {
    res.writeHead(302, { location: u.searchParams.get("to") ?? redirectTarget });
    return res.end();
  }
  if (u.pathname === "/loop") {
    res.writeHead(302, { location: "/loop" });
    return res.end();
  }
  if (u.pathname === "/to-file") {
    res.writeHead(302, { location: "file:///etc/passwd" });
    return res.end();
  }
  if (u.pathname === "/gzip" || u.pathname === "/deflate" || u.pathname === "/br") {
    const enc = u.pathname.slice(1);
    const body = enc === "gzip" ? zlib.gzipSync(ARTICLE) : enc === "deflate" ? zlib.deflateSync(ARTICLE) : zlib.brotliCompressSync(ARTICLE);
    res.writeHead(200, { "content-type": "text/html", "content-encoding": enc, "content-length": String(body.length) });
    return res.end(body);
  }
  if (u.pathname === "/bomb") {
    // 60 KB of zeros, compressed to well under 4 KB.
    const body = zlib.gzipSync(Buffer.alloc(60_000));
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": String(body.length) });
    return res.end(body);
  }
  if (u.pathname === "/big-declared") {
    res.writeHead(200, { "content-type": "text/html", "content-length": String(5000) });
    return res.end("x".repeat(5000));
  }
  if (u.pathname === "/big-streamed") {
    res.writeHead(200, { "content-type": "text/html" }); // chunked, no length
    res.write("x".repeat(3000));
    return setTimeout(() => res.end("y".repeat(3000)), 10);
  }
  if (u.pathname === "/hang") return; // never answers
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<h1>Not found</h1>");
}

/* A stand-in for dns.lookup(name, {all:true}, cb). `names` maps a host name
   to its addresses; every call is counted. */
function fakeDns(names) {
  const calls = [];
  const resolve = (hostname, options, cb) => {
    calls.push(hostname);
    const list = names[hostname];
    if (!list) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
    setImmediate(() => cb(null, list.map((address) => ({ address, family: net.isIP(address) }))));
  };
  return { resolve, calls };
}

let dir;
let app;
let dns;
async function boot(opts = {}) {
  dns = fakeDns({ "site.test": ["127.0.0.1"], localhost: ["127.0.0.1", "::1"], ...(opts.names ?? {}) });
  const fetchPage = {
    resolve: dns.resolve,
    allowHosts: [`site.test:${site.port}`, ...(opts.allowHosts ?? [])],
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.realDns ? { resolve: undefined, allowHosts: [] } : {}),
  };
  app = await startServer({ distDir: path.join(dir, "dist"), binDir: path.join(dir, "bin"), port: 0, fetchPage });
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-page-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
  site.requests = [];
  site.route = defaultRoute;
  redirectTarget = "";
});
afterEach(async () => {
  if (app) await new Promise((r) => app.server.close(r));
  app = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

/* A request as the renderer makes it: same Host as the app, the app header. */
function get(target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: app.port,
        path: `/api/fetch-page?url=${encodeURIComponent(target)}`,
        // x-nitroai-fetch is the round-5 header. It is sent too, so the same
        // tests run on 85f4a40 (the base check); the fix ignores it.
        headers: { "x-nitroai-app": "1", "x-nitroai-fetch": "1", "user-agent": "Mozilla/5.0 Chrome/140 Electron/43 NitroAI", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          let json = null;
          if ((res.headers["content-type"] ?? "").includes("json")) json = JSON.parse(body.toString("utf8"));
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const BLOCKED = { error: "blocked", reason: "the link points to this computer or a private network" };

describe("GET /api/fetch-page", () => {
  it("downloads the page in Node and gives back its bytes and content type", async () => {
    await boot();
    const r = await get(`${site.url}/wiki/Photosynthesis`);
    expect(r.status).toBe(200);
    expect(r.headers["x-nitroai-page"]).toBe("1");
    expect(r.headers["x-nitroai-content-type"]).toBe("text/html; charset=UTF-8");
    expect(r.body.toString("utf8")).toBe(ARTICLE);
    // The renderer's own User-Agent goes to the site, as its fetch() would send.
    expect(site.requests[0].headers["user-agent"]).toBe("Mozilla/5.0 Chrome/140 Electron/43 NitroAI");
    expect(site.requests[0].headers.host).toBe(`site.test:${site.port}`);
  });

  it("follows an http redirect and names the final URL", async () => {
    await boot();
    const r = await get(`${site.url}/moved`);
    expect(r.status).toBe(200);
    expect(r.headers["x-nitroai-final-url"]).toBe(`${site.url}/wiki/Photosynthesis`);
  });

  it("unpacks gzip, deflate and br pages", async () => {
    await boot();
    for (const p of ["/gzip", "/deflate", "/br"]) {
      const r = await get(`${site.url}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.body.toString("utf8"), p).toBe(ARTICLE);
    }
  });

  it("allows only http and https, and no user name or password in the link", async () => {
    await boot();
    for (const bad of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "data:text/html,hi", "chrome://settings"]) {
      const r = await get(bad);
      expect(r.status, bad).toBe(400);
      expect(r.json.error, bad).toBe("bad_scheme");
    }
    expect((await get("not a url")).json.error).toBe("bad_url");
    expect((await get(`http://me:secret@site.test:${site.port}/wiki/Photosynthesis`)).json.error).toBe("bad_url");
    expect(site.requests).toHaveLength(0);
  });

  it("does not follow a redirect to file://", async () => {
    await boot();
    const r = await get(`${site.url}/to-file`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers["x-nitroai-page"]).toBe("1");
    expect(r.body.toString("utf8")).not.toContain("root:");
  });

  it("stops at the download cap, declared, streamed or after unpacking (413 too_large)", async () => {
    const { MAX_PAGE_BYTES } = await import("./fetchPage.mjs");
    expect(MAX_PAGE_BYTES).toBe(8 * 1024 * 1024);
    await boot({ maxBytes: 4000 });
    for (const p of ["/big-declared", "/big-streamed", "/bomb"]) {
      const r = await get(`${site.url}${p}`);
      expect(r.status, p).toBe(413);
      expect(r.json, p).toEqual({ error: "too_large", limit: 4000 });
    }
  });

  it("an error page from the site is 502 with its status", async () => {
    await boot();
    const r = await get(`${site.url}/nowhere`);
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "status", status: 404 });
  });

  it("a site that cannot be reached, is not found, does not answer, or redirects in a loop is said in words", async () => {
    const closed = net.createServer();
    await new Promise((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    await boot({ timeoutMs: 300, names: { "dead.test": ["127.0.0.1"] }, allowHosts: [`dead.test:${deadPort}`] });
    const refused = await get(`http://dead.test:${deadPort}/`);
    expect(refused.status).toBe(502);
    expect(refused.json).toEqual({ error: "network", reason: "the site refused the connection" });
    const missing = await get("https://nowhere.test/");
    expect(missing.json).toEqual({ error: "network", reason: "the site was not found" });
    const loop = await get(`${site.url}/loop`);
    expect(loop.json).toEqual({ error: "network", reason: "the site redirected too many times" });
    expect(site.requests).toHaveLength(11); // the first request and 10 redirects
    const slow = await get(`${site.url}/hang`);
    expect(slow.status).toBe(504);
    expect(slow.json.error).toBe("timeout");
  });

  it("only the app can use it: a request without the app header, or with another Host, is 403", async () => {
    await boot();
    const noHeader = await get(`${site.url}/wiki/Photosynthesis`, { "x-nitroai-app": "" });
    expect(noHeader.status).toBe(403);
    // The old round-5 header alone is not enough now.
    expect((await get(`${site.url}/wiki/Photosynthesis`, { "x-nitroai-app": "", "x-nitroai-fetch": "1" })).status).toBe(403);
    // DNS rebinding: a page on evil.example whose name points at 127.0.0.1.
    const rebound = await get(`${site.url}/wiki/Photosynthesis`, { host: `evil.example:${app.port}` });
    expect(rebound.status).toBe(403);
    expect(site.requests).toHaveLength(0);
    expect((await get(`${site.url}/wiki/Photosynthesis`, { host: `localhost:${app.port}` })).status).toBe(200);
  });
});

describe("GET /api/fetch-page — the verifier's SSRF attacks (round 6, item 2)", () => {
  // The redirecting page runs on 127.0.0.1:<site port>; only that exact
  // host and port skips the check. The app's port is checked as in the app.
  it("a redirect to the app's own routes (localhost:<port>/api/publik/status, 127.0.0.1:<port>/api/publik/wallet and /v1/models) is refused", async () => {
    await boot({ allowHosts: [`127.0.0.1:${site.port}`] });
    for (const t of [
      `http://localhost:${app.port}/api/publik/status`,
      `http://127.0.0.1:${app.port}/api/publik/wallet`,
      `http://127.0.0.1:${app.port}/api/publik/v1/models`,
    ]) {
      site.requests = [];
      const r = await get(`http://127.0.0.1:${site.port}/go?to=${encodeURIComponent(t)}`);
      expect(r.status, t).toBe(403);
      expect(r.json, t).toEqual(BLOCKED);
      expect(site.requests, t).toHaveLength(1);
    }
  });

  it("a link to 169.254.169.254 (cloud metadata) or 192.0.2.1 is refused at once, with no connect", async () => {
    await boot({ timeoutMs: 1500 });
    for (const t of ["http://169.254.169.254/latest/meta-data/", "http://192.0.2.1/"]) {
      const t0 = Date.now();
      const r = await get(t);
      expect(r.json, t).toEqual(BLOCKED);
      expect(Date.now() - t0, t).toBeLessThan(500);
    }
  });
});

describe("GET /api/fetch-page — SSRF, more ranges and spellings (round 6, item 2)", () => {
  // The verifier's links: the app's own routes, loopback in every spelling,
  // 0.0.0.0, cloud metadata, the private ranges, IPv6 loopback, mapped,
  // unique-local and link-local.
  const appTargets = (port) => [
    `http://localhost:${port}/api/publik/status`,
    `http://127.0.0.1:${port}/api/publik/wallet`,
    `http://127.0.0.1:${port}/api/publik/v1/models`,
    `http://127.1:${port}/api/health`,
    `http://2130706433:${port}/api/health`,
    `http://0x7f000001:${port}/api/health`,
    `http://0.0.0.0:${port}/api/health`,
    `http://[::1]:${port}/api/health`,
    `http://[::ffff:127.0.0.1]:${port}/api/health`,
    `http://[::]:${port}/api/health`,
  ];
  const privateTargets = [
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.5.4/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://192.0.2.1/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
  ];

  it("refuses a link straight to this computer, the app's own routes or a private address (403 blocked)", async () => {
    await boot();
    for (const t of [...appTargets(app.port), ...appTargets(site.port), ...privateTargets]) {
      const r = await get(t);
      expect(r.status, t).toBe(403);
      expect(r.json, t).toEqual(BLOCKED);
      expect(r.headers["x-nitroai-page"], t).toBe("1");
    }
    expect(site.requests).toHaveLength(0);
    // An address in the link needs no lookup; only "localhost" was looked up.
    expect(new Set(dns.calls)).toEqual(new Set(["localhost"]));
  });

  it("refuses a redirect to any of them, after the first request (every hop is checked)", async () => {
    await boot();
    for (const t of [...appTargets(app.port), ...privateTargets]) {
      site.requests = [];
      const r = await get(`${site.url}/go?to=${encodeURIComponent(t)}`);
      expect(r.status, t).toBe(403);
      expect(r.json, t).toEqual(BLOCKED);
      expect(r.body.toString("utf8"), t).not.toContain("disclosureVersion");
      expect(site.requests.map((q) => q.url), t).toEqual([`/go?to=${encodeURIComponent(t)}`]);
    }
  });

  it("refuses a name that resolves to a private address, or to a public AND a private one", async () => {
    await boot({
      names: {
        "rebind.test": ["127.0.0.1"],
        "mixed.test": ["93.184.215.14", "10.1.2.3"],
        "mapped.test": ["::ffff:192.168.0.10"],
        "metadata.test": ["169.254.169.254"],
        "v6local.test": ["fe80::1"],
      },
    });
    for (const name of ["rebind.test", "mixed.test", "mapped.test", "metadata.test", "v6local.test"]) {
      const r = await get(`http://${name}:${site.port}/wiki/Photosynthesis`);
      expect(r.status, name).toBe(403);
      expect(r.json, name).toEqual(BLOCKED);
      // And as a redirect target from a page that is allowed.
      const hop = await get(`${site.url}/go?to=${encodeURIComponent(`http://${name}:${site.port}/wiki/Photosynthesis`)}`);
      expect(hop.json, `${name} via redirect`).toEqual(BLOCKED);
    }
    // Only the /go pages were downloaded; no blocked name reached the site.
    expect(site.requests.every((q) => q.url.startsWith("/go?"))).toBe(true);
  });

  it("with the real DNS, localhost is refused and nothing connects", async () => {
    await boot({ realDns: true });
    const r = await get(`http://localhost:${site.port}/wiki/Photosynthesis`);
    expect(r.json).toEqual(BLOCKED);
    expect(site.requests).toHaveLength(0);
  });

  it("pins the connection: ONE lookup per connection, and the socket connects to the address that lookup checked", async () => {
    await boot();
    const r = await get(`${site.url}/moved`);
    expect(r.status).toBe(200);
    // Two connections (the redirect and the page), two lookups — no second
    // lookup between the check and the connect that a rebinding name could
    // answer differently.
    expect(dns.calls).toEqual(["site.test", "site.test"]);
    expect(site.requests.map((q) => q.remote)).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  it("the checked lookup answers the socket with the checked address, in both lookup forms", async () => {
    const { checkedLookup } = await import("./fetchPage.mjs");
    let n = 0;
    // A rebinding DNS: public on the first answer, loopback after.
    const rebinding = (host, opts, cb) => cb(null, [{ address: n++ === 0 ? "93.184.215.14" : "127.0.0.1", family: 4 }]);
    const one = await new Promise((r) => checkedLookup(rebinding, false)("x.test", { family: 0 }, (...a) => r(a)));
    expect(one).toEqual([null, "93.184.215.14", 4]);
    // The next connection asks again and gets loopback: refused.
    const two = await new Promise((r) => checkedLookup(rebinding, false)("x.test", { all: true }, (...a) => r(a)));
    expect(two[0]?.code).toBe("EBLOCKED");
    const all = await new Promise((r) =>
      checkedLookup((h, o, cb) => cb(null, [{ address: "2606:4700::1111", family: 6 }, { address: "1.1.1.1", family: 4 }]), false)("y.test", { all: true }, (...a) => r(a)),
    );
    expect(all).toEqual([null, [{ address: "2606:4700::1111", family: 6 }, { address: "1.1.1.1", family: 4 }]]);
  });

  it("blockedAddress: loopback, private, link-local, unspecified, mapped and reserved are blocked; public is not", async () => {
    const { blockedAddress } = await import("./fetchPage.mjs");
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1",
      "169.254.169.254", "100.64.0.1", "192.0.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fd12:3456::1",
      "fe80::1", "fe80::1%en0", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "[::1]", "not-an-ip",
    ]) {
      expect(blockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "100.128.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect(blockedAddress(ip), ip).toBe(false);
    }
  });
});
