import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killAll, killTree, liveCount, track } from "./children.mjs";

function fakeChild(pid = 4242) {
  return Object.assign(new EventEmitter(), { pid, kill: vi.fn() });
}

afterEach(() => {
  killAll({ platform: "linux" });
});

describe("the programs the server starts end with the app", () => {
  it("forgets a child that ended by itself", () => {
    const a = track(fakeChild());
    const b = track(fakeChild());
    expect(liveCount()).toBe(2);
    a.emit("exit", 0);
    b.emit("error", new Error("ENOENT"));
    expect(liveCount()).toBe(0);
    expect(killAll({ platform: "linux" })).toBe(0);
  });

  it("passes through a value that is not a child", () => {
    expect(track(undefined)).toBeUndefined();
    expect(liveCount()).toBe(0);
  });

  it("macOS and Linux: one signal to each child", () => {
    const a = track(fakeChild(1));
    const b = track(fakeChild(2));
    const run = vi.fn();
    expect(killAll({ platform: "darwin", run })).toBe(2);
    expect(a.kill).toHaveBeenCalledTimes(1);
    expect(b.kill).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(liveCount()).toBe(0);
  });

  it("Windows: taskkill ends the whole tree, and kill() is not sent first", () => {
    const child = track(fakeChild(777));
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const run = vi.fn(() => killer);
    killAll({ platform: "win32", run });
    expect(run).toHaveBeenCalledWith("taskkill", ["/pid", "777", "/T", "/F"], { stdio: "ignore", windowsHide: true });
    expect(killer.unref).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    // No taskkill on the computer: the plain kill is the fallback.
    killer.emit("error", new Error("ENOENT"));
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("Windows: falls back to kill() when taskkill cannot start", () => {
    const child = fakeChild(5);
    killTree(child, { platform: "win32", run: () => { throw new Error("spawn failed"); } });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("never throws: a child that is already gone", () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => { throw new Error("ESRCH"); });
    expect(() => killTree(child, { platform: "linux" })).not.toThrow();
    expect(() => killTree(null)).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("ends a real process", async () => {
    const child = track(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
    const ended = new Promise((r) => child.once("exit", (code, signal) => r(signal)));
    expect(killAll()).toBe(1);
    expect(await ended).toBe("SIGTERM");
  });
});
