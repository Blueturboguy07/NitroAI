// Unit tests of startUpdates() in electron/publik-updater.cjs: the daily check and the "Check for Updates…"
// menu item. The real updater module runs. Electron and electron-updater's autoUpdater are fakes (given to
// the module through Module._load), and the 24-hour timer runs on vitest's fake timers.
//
// The live proof (.github/workflows/live-update-proof.yml) clicks the menu item on the macOS runners. This
// file also covers the Windows menu (Help › Check for Updates…), which the runner cannot click, and the
// restart question ("Restart Now" / "Later").
import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UPDATER = require.resolve('../electron/publik-updater.cjs');
const { startUpdates } = require(UPDATER);
const DAY = 24 * 60 * 60 * 1000;

let current = null; // the fakes of the running test
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (current && parent && parent.filename === UPDATER) {
    if (request === 'electron') return current.electron;
    if (request === 'electron-updater') return { autoUpdater: current.autoUpdater };
  }
  return realLoad.call(this, request, parent, isMain);
};

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const realResourcesPath = process.resourcesPath;
const realPublikUpdates = process.env.PUBLIK_UPDATES;

afterEach(() => {
  current = null;
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', realPlatform);
  process.resourcesPath = realResourcesPath;
  if (realPublikUpdates === undefined) delete process.env.PUBLIK_UPDATES;
  else process.env.PUBLIK_UPDATES = realPublikUpdates;
});

/**
 * Fakes for one test. `latest` is the version the fake feed offers. A check emits what electron-updater
 * emits: checking-for-update, then update-not-available (latest = running version) or update-available.
 * `answer` is the button index the fake dialog returns (0 = the first button).
 */
function setUp({ platform, version = '0.2.7', latest = version, answer = 0, packaged = true } = {}) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true, enumerable: true, writable: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publik-updater-test-'));
  fs.writeFileSync(path.join(dir, 'app-update.yml'), 'provider: generic\nurl: https://publikhq.com/api/updates/nitroai/\n');
  process.resourcesPath = dir; // resources/app-update.yml exists, as in an installed app
  delete process.env.PUBLIK_UPDATES;

  const autoUpdater = new EventEmitter();
  autoUpdater.checks = [];
  autoUpdater.installs = [];
  autoUpdater.setFeedURL = (options) => { autoUpdater.feed = options; };
  autoUpdater.quitAndInstall = (...args) => { autoUpdater.installs.push(args); };
  autoUpdater.checkForUpdates = () => {
    autoUpdater.checks.push(Date.now());
    autoUpdater.emit('checking-for-update');
    if (f.latest === version) autoUpdater.emit('update-not-available', { version: f.latest });
    else autoUpdater.emit('update-available', { version: f.latest });
    return Promise.resolve(null);
  };

  const dialogs = [];
  let template = null;
  const electron = {
    app: { isPackaged: packaged, getName: () => 'NitroAI', getVersion: () => version, getAppPath: () => dir, getPath: () => dir },
    dialog: {
      showMessageBox: (a, b) => {
        dialogs.push(b || a);
        return Promise.resolve({ response: f.answer });
      },
    },
    BrowserWindow: { getFocusedWindow: () => null },
    Menu: { buildFromTemplate: (t) => { template = t; return t; }, setApplicationMenu: () => {} },
    autoUpdater: new EventEmitter(), // Electron's native autoUpdater (Squirrel.Mac)
  };
  const f = { autoUpdater, electron, dialogs, latest, answer, menu: () => template };
  current = f;
  return f;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The "Check for Updates…" item of the menu that startUpdates() set: macOS app menu, Windows Help menu. */
function checkItem(template, platform) {
  const menu = platform === 'darwin' ? template[0] : template.find((m) => m.role === 'help');
  assert.ok(menu, 'the menu that holds the item');
  const item = menu.submenu.find((i) => i && i.label === 'Check for Updates…');
  assert.ok(item, '"Check for Updates…" is in the menu');
  return item;
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a check at launch, then one every 24 hours (fake timers)`, () => {
    vi.useFakeTimers();
    const f = setUp({ platform });
    const t0 = Date.now();
    startUpdates({ slug: 'nitroai', appName: 'NitroAI' });
    assert.equal(f.autoUpdater.checks.length, 1, 'one check at launch');
    assert.equal(f.autoUpdater.feed.url, 'https://publikhq.com/api/updates/nitroai/', 'the live feed');
    vi.advanceTimersByTime(DAY - 1000);
    assert.equal(f.autoUpdater.checks.length, 1, 'no second check before 24 hours');
    vi.advanceTimersByTime(1000);
    assert.equal(f.autoUpdater.checks.length, 2, 'the second check at 24 hours');
    assert.equal(f.autoUpdater.checks[1] - t0, DAY);
    vi.advanceTimersByTime(2 * DAY);
    assert.equal(f.autoUpdater.checks.length, 4, 'one check each day');
    assert.equal(f.dialogs.length, 0, 'a background check with no update shows nothing');
  });
}

test('the daily check skips a day while an update waits for a restart', () => {
  vi.useFakeTimers();
  const f = setUp({ platform: 'win32', latest: '0.2.8', answer: 1 });
  startUpdates({ slug: 'nitroai', appName: 'NitroAI' });
  assert.equal(f.autoUpdater.checks.length, 1);
  f.autoUpdater.emit('update-downloaded', { version: '0.2.8' }); // Windows: ready at once
  vi.advanceTimersByTime(DAY);
  assert.equal(f.autoUpdater.checks.length, 1, 'no new check: the downloaded update waits');
});

test('PUBLIK_UPDATES=0 and a build that is not packaged make no automatic check', () => {
  vi.useFakeTimers();
  let f = setUp({ platform: 'darwin' });
  process.env.PUBLIK_UPDATES = '0';
  startUpdates({ slug: 'nitroai', appName: 'NitroAI' });
  vi.advanceTimersByTime(3 * DAY);
  assert.equal(f.autoUpdater.checks.length, 0);
  f = setUp({ platform: 'darwin', packaged: false });
  startUpdates({ slug: 'nitroai', appName: 'NitroAI' });
  vi.advanceTimersByTime(3 * DAY);
  assert.equal(f.autoUpdater.checks.length, 0);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: "Check for Updates…" with no update shows "You’re up to date." and the version`, async () => {
    const f = setUp({ platform });
    process.env.PUBLIK_UPDATES = '0'; // no launch check: only the click checks
    startUpdates({ slug: 'nitroai', appName: 'NitroAI' });
    checkItem(f.menu(), platform).click();
    await settle();
    assert.equal(f.autoUpdater.checks.length, 1, 'the click ran one check');
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].message, 'You’re up to date.');
    assert.equal(f.dialogs[0].detail, 'NitroAI 0.2.7 is the newest version.');
  });

  test(`${platform}: "Check for Updates…" with an update: "available", then "Restart Now" installs`, async () => {
    const f = setUp({ platform, latest: '0.2.8', answer: 0 });
    process.env.PUBLIK_UPDATES = '0';
    startUpdates({ slug: 'nitroai', appName: 'NitroAI' });
    checkItem(f.menu(), platform).click();
    await settle();
    assert.equal(f.dialogs[0].message, 'NitroAI 0.2.8 is available.');
    f.autoUpdater.emit('update-downloaded', { version: '0.2.8' });
    if (platform === 'darwin') {
      await settle();
      assert.equal(f.dialogs.length, 1, 'macOS: no question before Squirrel.Mac accepts the update');
      f.electron.autoUpdater.emit('update-downloaded');
    }
    await settle();
    const ask = f.dialogs[1];
    assert.equal(ask.message, 'NitroAI 0.2.8 is ready to install.');
    assert.deepEqual(ask.buttons, ['Restart Now', 'Later']);
    await settle();
    await settle();
    assert.deepEqual(f.autoUpdater.installs, [[true, true]], '"Restart Now" calls quitAndInstall(silent, run after)');
  });
}

test('"Later" installs nothing now; the update installs when the app quits', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const f = setUp({ platform: 'darwin', latest: '0.2.8', answer: 1 });
  startUpdates({ slug: 'nitroai', appName: 'NitroAI' }); // the launch check finds 0.2.8
  assert.equal(f.dialogs.length, 0, 'a background check shows no "available" dialog');
  f.autoUpdater.emit('update-downloaded', { version: '0.2.8' });
  f.electron.autoUpdater.emit('update-downloaded');
  await settle();
  await settle();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].message, 'NitroAI 0.2.8 is ready to install.');
  assert.equal(f.autoUpdater.installs.length, 0, '"Later" does not restart');
  assert.equal(f.autoUpdater.autoInstallOnAppQuit, true, 'the update installs at quit');
  // A click on the menu item later asks again (the update is still waiting).
  checkItem(f.menu(), 'darwin').click();
  await settle();
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.dialogs[1].message, 'NitroAI 0.2.8 is ready to install.');
  assert.equal(f.autoUpdater.checks.length, 1, 'no new download');
});
