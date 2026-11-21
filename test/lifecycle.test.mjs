import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armQuit, guardWindow, QUIT_DEADLINE_MS, CLOSE_DEADLINE_MS, RELOAD_LIMIT, RELOAD_WINDOW_MS, shouldQuitWhenAllClosed } from "../electron/lifecycle.mjs";

function fakeApp() {
  return Object.assign(new EventEmitter(), { exit: vi.fn(), quit: vi.fn() });
}
function fakeWindow() {
  let destroyed = false;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
      win.emit("closed");
    }),
    webContents: Object.assign(new EventEmitter(), { reload: vi.fn() }),
  });
  return win;
}
const log = { write: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the last window closed", () => {
  it("quits on Windows and Linux, not on macOS, and not during the start", () => {
    expect(shouldQuitWhenAllClosed({ starting: false, platform: "win32" })).toBe(true);
    expect(shouldQuitWhenAllClosed({ starting: false, platform: "linux" })).toBe(true);
    expect(shouldQuitWhenAllClosed({ starting: false, platform: "darwin" })).toBe(false);
    expect(shouldQuitWhenAllClosed({ starting: true, platform: "win32" })).toBe(false);
  });
});

describe("quit always ends", () => {
  it("a normal quit: the clean-up runs once, at will-quit", () => {
    const app = fakeApp();
    const cleanup = vi.fn();
    const quit = armQuit(app, { cleanup, log });
    expect(quit.quitting()).toBe(false);
    app.emit("before-quit");
    expect(quit.quitting()).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    app.emit("will-quit");
    app.emit("will-quit");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("a quit that hangs: after 3 seconds the clean-up runs and app.exit() ends the process", () => {
    const app = fakeApp();
    const cleanup = vi.fn();
    armQuit(app, { cleanup, log });
    app.emit("before-quit");
    app.emit("before-quit"); // a second request starts no second deadline
    vi.advanceTimersByTime(QUIT_DEADLINE_MS - 1);
    expect(app.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(log.write).toHaveBeenCalledWith("quit-forced", null, { afterMs: QUIT_DEADLINE_MS });
  });

  it("a clean-up that throws does not stop the quit", () => {
    const app = fakeApp();
    armQuit(app, { cleanup: () => { throw new Error("close failed"); }, log });
    app.emit("before-quit");
    expect(() => app.emit("will-quit")).not.toThrow();
    expect(log.write).toHaveBeenCalledWith("quit-cleanup-failed", expect.any(Error));
    vi.advanceTimersByTime(QUIT_DEADLINE_MS);
    expect(app.exit).toHaveBeenCalledWith(0);
  });
});

describe("a window always closes", () => {
  it("a window that closes in time is left alone", () => {
    const win = fakeWindow();
    guardWindow(win, { log });
    win.emit("close", {});
    win.emit("closed");
    vi.advanceTimersByTime(CLOSE_DEADLINE_MS * 2);
    expect(win.destroy).not.toHaveBeenCalled();
    expect(log.write).not.toHaveBeenCalled();
  });

  it("a window whose page does not answer is destroyed 3 seconds after the close request", () => {
    const win = fakeWindow();
    guardWindow(win, { log });
    win.emit("close", {});
    win.emit("close", {}); // a second click starts no second timer
    win.emit("unresponsive");
    vi.advanceTimersByTime(CLOSE_DEADLINE_MS - 1);
    expect(win.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(log.write).toHaveBeenCalledWith("window-unresponsive");
    expect(log.write).toHaveBeenCalledWith("window-close-forced", null, { afterMs: CLOSE_DEADLINE_MS });
    vi.advanceTimersByTime(CLOSE_DEADLINE_MS * 2);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("a page whose process ended loads again, at most 3 times in a minute", () => {
    const win = fakeWindow();
    let t = 0;
    guardWindow(win, { log, now: () => t });
    for (let i = 0; i < RELOAD_LIMIT + 2; i++) win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(win.webContents.reload).toHaveBeenCalledTimes(RELOAD_LIMIT);
    t = RELOAD_WINDOW_MS + 1;
    win.webContents.emit("render-process-gone", {}, { reason: "oom" });
    expect(win.webContents.reload).toHaveBeenCalledTimes(RELOAD_LIMIT + 1);
  });

  it("no reload for a clean exit or a destroyed window", () => {
    const win = fakeWindow();
    guardWindow(win, { log });
    win.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
    win.destroy();
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });
});
