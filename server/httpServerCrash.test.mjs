/* The local server must not throw out of a request: in the desktop app it
   runs inside the Electron main process, where an uncaught error stops the
   app (bug report: "crashed a couple of times"). And it must stop at once on
   quit, also with a request still open ("it refused to close"). */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./httpServer.mjs";

let dir;
let app;
let errors;

/* One raw request line: fetch() and http.request() both clean the path first. */
function raw(port, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let text = "";
    socket.setEncoding("utf8").on("data", (c) => (text += c));
    socket.on("end", () => resolve(text));
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-crash-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
  errors = [];
  app = await startServer({ distDir: path.join(dir, "dist"), port: 0, onError: (err) => errors.push(err) });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stopServer(app?.server);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a bad request does not stop the server", () => {
  it("answers 400 for a path with a broken percent sign, and still serves", async () => {
    expect(await raw(app.port, "GET /%E0%A4%A HTTP/1.1")).toMatch(/^HTTP\/1\.1 400 /);
    expect(await raw(app.port, "GET /notes/%zz HTTP/1.1")).toMatch(/^HTTP\/1\.1 400 /);
    const res = await fetch(`${app.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>app</html>");
  });

  it("answers 400 for a path that is not a URL", async () => {
    expect(await raw(app.port, "GET // HTTP/1.1")).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(`${app.url}/`)).status).toBe(200);
  });

  it("answers 404 for a path with a NUL byte", async () => {
    fs.rmSync(path.join(dir, "dist", "index.html"));
    expect(await raw(app.port, "GET /a%00b HTTP/1.1")).toMatch(/^HTTP\/1\.1 404 /);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("answers 404 for a file it cannot read, and still serves", async () => {
    const locked = path.join(dir, "dist", "locked.js");
    fs.writeFileSync(locked, "x");
    fs.chmodSync(locked, 0o000);
    expect(await raw(app.port, "GET /locked.js HTTP/1.1")).toMatch(/^HTTP\/1\.1 404 /);
    expect((await fetch(`${app.url}/`)).status).toBe(200);
  });
});

describe("the port", () => {
  it("tries the next port when one is refused for a reason other than 'in use' (Windows: EACCES on a reserved port)", async () => {
    const listen = http.Server.prototype.listen;
    let first = true;
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (...args) {
      if (first) {
        first = false;
        queueMicrotask(() => this.emit("error", Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES" })));
        return this;
      }
      return listen.apply(this, args);
    });
    const second = await startServer({ distDir: path.join(dir, "dist"), ports: [41763, 0] });
    try {
      expect(second.port).toBeGreaterThan(0);
      expect((await fetch(`${second.url}/`)).status).toBe(200);
    } finally {
      await stopServer(second.server);
    }
  });

  it("rejects when the last port is refused", async () => {
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function () {
      queueMicrotask(() => this.emit("error", Object.assign(new Error("listen EACCES"), { code: "EACCES" })));
      return this;
    });
    await expect(startServer({ distDir: path.join(dir, "dist"), ports: [41763, 41764] })).rejects.toThrow(/EACCES/);
  });

  it("an error on the listening server is reported, not thrown", () => {
    const err = new Error("accept failed");
    expect(() => app.server.emit("error", err)).not.toThrow();
    expect(errors).toContain(err);
  });
});

describe("stopServer", () => {
  it("stops at once with a request still open", async () => {
    // A request that never ends: server.close() alone waits for it for ever.
    const socket = net.connect(app.port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    socket.resume();
    socket.write("POST /api/health HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npart");
    await new Promise((r) => setTimeout(r, 50));
    const closed = new Promise((r) => socket.once("close", r));
    const t0 = Date.now();
    await stopServer(app.server);
    await closed;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(app.server.listening).toBe(false);
  });

  it("is safe to call twice, and with nothing", async () => {
    await stopServer(app.server);
    await stopServer(app.server);
    await stopServer(null);
  });
});
