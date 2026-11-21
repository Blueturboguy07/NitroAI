/* electron/main.mjs itself, with Electron and the server replaced by
   stand-ins: the rules of lifecycle.mjs are really wired to the app's events.
   No window opens and no port is used. */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class BrowserWindow extends EventEmitter {
    static all = [];
    static getAllWindows = () => BrowserWindow.all.filter((w) => !w.destroyed);
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, reload() {} });
      BrowserWindow.all.push(this);
    }
    loadURL() { return state.loadURL ? state.loadURL() : Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return true; }
    setMenuBarVisibility() {}
    setTitle() {}
    show() {}
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
      if (BrowserWindow.getAllWindows().length === 0) state.app.emit("window-all-closed");
    }
    close() { this.emit("close", {}); this.destroy(); }
  }
  state.BrowserWindow = BrowserWindow;
  return {
    get app() { return state.app; },
    BrowserWindow,
    dialog: { showErrorBox: (...a) => state.showErrorBox(...a) },
    shell: { openExternal() {} },
    ipcMain: { on() {}, removeListener() {} },
  };
});
vi.mock("node:module", async (original) => ({
  ...(await original()),
  createRequire: () => () => ({ startUpdates: (...a) => state.startUpdates(...a) }),
}));
vi.mock("../server/httpServer.mjs", () => ({
  STABLE_PORTS: [0],
  startServer: (...a) => state.startServer(...a),
  stopServer: (...a) => state.stopServer(...a),
}));
vi.mock("../server/ollama.mjs", () => ({ ensureServingIfProvisioned: async () => false, shutdown: () => state.shutdownOllama() }));
vi.mock("../server/children.mjs", () => ({ killAll: () => state.killChildren() }));
vi.mock("../server/publik.mjs", () => ({ ensureSignedIn: (...a) => state.ensureSignedIn(...a), hasAppToken: () => false }));

const realPlatform = process.platform;
const before = { uncaughtException: process.listeners("uncaughtException"), unhandledRejection: process.listeners("unhandledRejection") };
let dir;

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
/* Starts main.mjs. Resolves when the start (the whenReady chain) has ended. */
async function start() {
  vi.resetModules();
  await import("../electron/main.mjs");
  state.ready();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
const crashKinds = () => {
  try {
    return fs.readFileSync(path.join(dir, "crash.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
  } catch {
    return [];
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-main-"));
  delete process.env.PUBLIK_UPDATER_TEST;
  delete process.env.PUBLIK_SELF_TEST;
  const whenReady = new Promise((r) => (state.ready = r));
  state.app = Object.assign(new EventEmitter(), {
    whenReady: () => whenReady,
    getPath: () => dir,
    getVersion: () => "0.0.0-test",
    getName: () => "NitroAI",
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
  });
  state.server = { name: "server" };
  state.startServer = vi.fn(async () => ({ server: state.server, port: 1, url: "http://127.0.0.1:1" }));
  state.stopServer = vi.fn(async () => {});
  state.shutdownOllama = vi.fn();
  state.killChildren = vi.fn();
  state.ensureSignedIn = vi.fn(async () => ({}));
  state.startUpdates = vi.fn(() => ({ testHook: false }));
  state.showErrorBox = vi.fn();
  state.loadURL = null;
  if (state.BrowserWindow) state.BrowserWindow.all = [];
  setPlatform("win32");
});
afterEach(() => {
  vi.useRealTimers();
  state.app.emit("will-quit"); // ends the health watch of this copy
  setPlatform(realPlatform);
  for (const name of Object.keys(before)) {
    for (const l of process.listeners(name)) if (!before[name].includes(l)) process.removeListener(name, l);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => setPlatform(realPlatform));

describe("main.mjs: close and quit", () => {
  it("Windows: closing the app's window quits; the quit stops the server, the programs and Ollama", async () => {
    await start();
    const windows = state.BrowserWindow.getAllWindows();
    expect(windows).toHaveLength(1); // the splash is gone, the app's window is open
    expect(state.app.quit).not.toHaveBeenCalled();
    windows[0].close();
    expect(state.app.quit).toHaveBeenCalledTimes(1);
    state.app.emit("before-quit");
    state.app.emit("will-quit");
    expect(state.stopServer).toHaveBeenCalledWith(state.server);
    expect(state.killChildren).toHaveBeenCalledTimes(1);
    expect(state.shutdownOllama).toHaveBeenCalledTimes(1);
    expect(state.app.releaseSingleInstanceLock).toHaveBeenCalled();
  });

  it("a quit that does not end is ended by app.exit() after 3 seconds", async () => {
    await start();
    vi.useFakeTimers();
    state.app.emit("before-quit"); // and 'will-quit' never comes
    vi.advanceTimersByTime(2999);
    expect(state.app.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(state.app.exit).toHaveBeenCalledWith(0);
    expect(state.stopServer).toHaveBeenCalledWith(state.server);
    expect(crashKinds()).toContain("quit-forced");
  });

  it("macOS: closing the window does not quit", async () => {
    setPlatform("darwin");
    await start();
    state.BrowserWindow.getAllWindows()[0].close();
    expect(state.app.quit).not.toHaveBeenCalled();
  });

  it("during the start, the splash closing for the sign-in window is not 'the last window closed'", async () => {
    let signedIn;
    state.ensureSignedIn = vi.fn(() => new Promise((r) => (signedIn = r)));
    await start();
    const [splash] = state.BrowserWindow.getAllWindows();
    splash.destroy(); // -> window-all-closed, with the start still running
    expect(state.app.quit).not.toHaveBeenCalled();
    signedIn({});
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(state.BrowserWindow.getAllWindows()).toHaveLength(1);
    expect(state.app.quit).not.toHaveBeenCalled();
  });

  it("a start that fails says so, writes the crash log and quits: no process is left with no window", async () => {
    state.startServer = vi.fn(async () => { throw Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:41763"), { code: "EACCES" }); });
    await start();
    expect(state.BrowserWindow.getAllWindows()).toHaveLength(0);
    expect(state.showErrorBox).toHaveBeenCalledTimes(1);
    expect(state.showErrorBox.mock.calls[0][1]).toContain("EACCES");
    expect(state.app.quit).toHaveBeenCalled();
    expect(crashKinds()).toEqual(["startup-failed"]);
  });

  it("Windows: the window closed while the page loaded: the app quits when the start ends", async () => {
    let failLoad;
    state.loadURL = () => new Promise((_, reject) => (failLoad = reject));
    await start();
    const win = state.BrowserWindow.getAllWindows().find((w) => w.listenerCount("close") > 0);
    for (const w of state.BrowserWindow.getAllWindows()) w.destroy();
    expect(win).toBeTruthy();
    expect(state.app.quit).not.toHaveBeenCalled(); // still starting
    failLoad(new Error("ERR_FAILED"));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(state.app.quit).toHaveBeenCalledTimes(1);
    expect(state.showErrorBox).not.toHaveBeenCalled();
    expect(crashKinds()).toEqual(["load-failed"]);
  });

  it("the CI update proof is left alone: no window, no quit from here", async () => {
    state.startUpdates = vi.fn(() => ({ testHook: true }));
    await start();
    expect(state.BrowserWindow.getAllWindows()).toHaveLength(0);
    expect(state.ensureSignedIn).not.toHaveBeenCalled();
    expect(state.app.quit).not.toHaveBeenCalled();
  });
});
