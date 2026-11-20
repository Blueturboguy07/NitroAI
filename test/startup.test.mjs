import { describe, expect, it, vi, beforeEach } from "vitest";

const app = { requestSingleInstanceLock: vi.fn(), quit: vi.fn(), on: vi.fn() };
vi.mock("electron", () => ({ app, BrowserWindow: class {} }));

const { focusFirst, isTestRun, takeSingleInstance } = await import("../electron/startup.mjs");

function win({ destroyed = false, minimized = false } = {}) {
  return { isDestroyed: () => destroyed, isMinimized: () => minimized, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PUBLIK_UPDATER_TEST;
  delete process.env.PUBLIK_SELF_TEST;
});

describe("one copy of the app", () => {
  it("the second copy quits and does not listen", () => {
    app.requestSingleInstanceLock.mockReturnValue(false);
    expect(takeSingleInstance(() => [])).toBe(false);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.on).not.toHaveBeenCalled();
  });

  it("the first copy brings its window forward when a second one starts", () => {
    app.requestSingleInstanceLock.mockReturnValue(true);
    const gone = win({ destroyed: true });
    const main = win({ minimized: true });
    const other = win();
    expect(takeSingleInstance(() => [null, gone, main, other])).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    const [event, handler] = app.on.mock.calls[0];
    expect(event).toBe("second-instance");
    handler();
    expect(main.restore).toHaveBeenCalled();
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
    expect(gone.focus).not.toHaveBeenCalled();
  });

  it("a test run (update proof, self-test) takes no lock", () => {
    process.env.PUBLIK_UPDATER_TEST = "1";
    expect(isTestRun()).toBe(true);
    expect(takeSingleInstance(() => [])).toBe(true);
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
  });

  it("focusFirst answers null when no window is left", () => {
    expect(focusFirst([null, win({ destroyed: true })])).toBeNull();
  });
});
