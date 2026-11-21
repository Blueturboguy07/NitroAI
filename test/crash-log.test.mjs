import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrashLog, installCrashHandlers } from "../electron/crashLog.mjs";

let dir;
const lines = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-crashlog-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the local crash log", () => {
  it("writes one JSON line for each event, with the app's version, in a folder it makes", () => {
    const file = path.join(dir, "data", "crash.log");
    const log = createCrashLog(file, { info: { version: "0.2.11", platform: "win32" }, now: () => new Date("2026-11-20T10:00:00Z") });
    log.write("uncaughtException", Object.assign(new Error("boom"), { code: "EBOOM" }));
    log.write("render-process-gone", null, { reason: "crashed", exitCode: 5 });
    log.write("unhandledRejection", "a plain text reason");
    const [a, b, c] = lines(file);
    expect(a).toMatchObject({ t: "2026-11-20T10:00:00.000Z", kind: "uncaughtException", version: "0.2.11", platform: "win32", message: "boom", code: "EBOOM" });
    expect(a.stack).toContain("boom");
    expect(b).toMatchObject({ kind: "render-process-gone", reason: "crashed", exitCode: 5 });
    expect(b.message).toBeUndefined();
    expect(c).toMatchObject({ kind: "unhandledRejection", message: "a plain text reason" });
  });

  it("keeps the file small: a full file becomes crash.log.1", () => {
    const file = path.join(dir, "crash.log");
    const log = createCrashLog(file, { maxBytes: 3000 });
    log.write("a", new Error("x".repeat(4000)));
    log.write("b", new Error("second"));
    log.write("c", new Error("third"));
    expect(lines(`${file}.1`).map((l) => l.kind)).toEqual(["a"]);
    expect(lines(file).map((l) => l.kind)).toEqual(["b", "c"]);
  });

  it("never throws: a path that cannot be written, a value that is not JSON", () => {
    fs.writeFileSync(path.join(dir, "a-file"), "");
    const log = createCrashLog(path.join(dir, "a-file", "crash.log"));
    expect(() => log.write("x", new Error("no folder"))).not.toThrow();
    const loop = {};
    loop.self = loop;
    const ok = createCrashLog(path.join(dir, "crash.log"));
    expect(() => ok.write("x", loop)).not.toThrow();
    expect(lines(ok.file)[0].message).toBe("[object Object]");
  });

  it("cuts a very long message", () => {
    const log = createCrashLog(path.join(dir, "crash.log"));
    log.write("x", new Error("y".repeat(50_000)));
    expect(lines(log.file)[0].message.length).toBe(8000);
  });
});

describe("the crash handlers", () => {
  it("write an uncaught error, an unhandled rejection and an ended process, and do not throw again", () => {
    const proc = new EventEmitter();
    const app = new EventEmitter();
    const log = createCrashLog(path.join(dir, "crash.log"));
    installCrashHandlers({ proc, app, log });
    // With a listener, Node (and Electron) do not stop the process and show no error box.
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    proc.emit("uncaughtException", new TypeError("Invalid URL"));
    proc.emit("unhandledRejection", new Error("fetch failed"));
    app.emit("render-process-gone", {}, {}, { reason: "oom", exitCode: -536870904 });
    app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 1 });
    expect(lines(log.file).map((l) => [l.kind, l.message ?? l.reason])).toEqual([
      ["uncaughtException", "Invalid URL"],
      ["unhandledRejection", "fetch failed"],
      ["render-process-gone", "oom"],
      ["child-process-gone", "crashed"],
    ]);
    expect(lines(log.file)[3].type).toBe("GPU");
  });
});
