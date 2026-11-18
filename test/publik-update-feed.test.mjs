// Unit tests of the parts of scripts/publik-update-feed.cjs that NitroAI needs beyond the shared template:
// installer names without the version (the version is read INSIDE each file instead) and one mac zip per
// arch (arm64 and x64) in latest-mac.yml. The `write` command runs as a child process, as in CI.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'publik-update-feed.cjs');
const { embeddedVersion } = require(SCRIPT);

/** A small zip file (local headers, central directory, end record), stored or deflated entries. */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data);
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(raw) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const plist = (version) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.nitroai.app</string>\n  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict>\n</plist>\n`;

/** A mac zip as electron-builder makes it: the app's Info.plist, plus a framework Info.plist with another version. */
const macZip = (version, deflate = true) =>
  makeZip([
    { name: 'NitroAI.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist', data: plist('43.1.1'), deflate },
    { name: 'NitroAI.app/Contents/Info.plist', data: plist(version), deflate },
    { name: 'NitroAI.app/Contents/Resources/app.asar', data: crypto.randomBytes(5000), deflate },
  ]);

/** The start of a Windows installer: a PE version resource with ProductVersion, then other bytes. */
const fakeExe = (version) =>
  Buffer.concat([
    Buffer.from('MZ'),
    crypto.randomBytes(300).map((b) => b | 1), // no 00 00 pairs
    Buffer.from('ProductVersion\0', 'utf16le'),
    Buffer.alloc(2),
    Buffer.from(`${version}\0`, 'utf16le'),
    crypto.randomBytes(300),
  ]);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feed-test-'));
const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
const runWrite = (args) => spawnSync(process.execPath, [SCRIPT, 'write', ...args], { encoding: 'utf8' });
const BASE = 'https://github.com/Blueturboguy07/NitroAI/releases/download/v0.2.7/';

test('the version inside a mac zip is the app Info.plist, not a framework one (deflated and stored)', () => {
  const d = tmp();
  for (const deflate of [true, false]) {
    const f = path.join(d, `NitroAI-mac-arm64-${deflate}.zip`);
    fs.writeFileSync(f, macZip('0.2.7', deflate));
    assert.equal(embeddedVersion(f), '0.2.7');
  }
  fs.writeFileSync(path.join(d, 'empty.zip'), makeZip([{ name: 'readme.txt', data: 'x' }]));
  assert.equal(embeddedVersion(path.join(d, 'empty.zip')), null);
});

test('the version inside a Windows installer is its ProductVersion', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.exe'), fakeExe('0.0.0-updtest.12.1.2'));
  assert.equal(embeddedVersion(path.join(d, 'a.exe')), '0.0.0-updtest.12.1.2');
  fs.writeFileSync(path.join(d, 'b.exe'), crypto.randomBytes(1000));
  assert.equal(embeddedVersion(path.join(d, 'b.exe')), null);
});

test('write: latest-mac.yml lists the arm64 and x64 zips first, then the dmgs, with absolute URLs and sha512', () => {
  const d = tmp();
  const f = (n) => path.join(d, n);
  fs.writeFileSync(f('NitroAI-mac-arm64.zip'), macZip('0.2.7'));
  fs.writeFileSync(f('NitroAI-mac-x64.zip'), macZip('0.2.7'));
  fs.writeFileSync(f('NitroAI-mac-arm64.dmg'), crypto.randomBytes(100));
  fs.writeFileSync(f('NitroAI-mac-x64.dmg'), crypto.randomBytes(100));
  fs.writeFileSync(f('NitroAI-Setup-Windows.exe'), fakeExe('0.2.7'));
  const r = runWrite(['--app', 'nitroai', '--version', '0.2.7', '--download-base', BASE, '--out', f('feed'),
    '--win', f('NitroAI-Setup-Windows.exe'),
    '--mac-zip', f('NitroAI-mac-arm64.zip'), '--mac-zip', f('NitroAI-mac-x64.zip'),
    '--mac-dmg', f('NitroAI-mac-arm64.dmg'), '--mac-dmg', f('NitroAI-mac-x64.dmg')]);
  assert.equal(r.status, 0, r.stderr);
  const mac = fs.readFileSync(f('feed/latest-mac.yml'), 'utf8');
  const urls = [...mac.matchAll(/- url: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(urls, ['NitroAI-mac-arm64.zip', 'NitroAI-mac-x64.zip', 'NitroAI-mac-arm64.dmg', 'NitroAI-mac-x64.dmg'].map((n) => BASE + n));
  assert.match(mac, /^version: '0\.2\.7'\npublikApp: 'nitroai'\n/);
  assert.ok(mac.includes(`sha512: '${sha512(f('NitroAI-mac-x64.zip'))}'`));
  assert.ok(mac.includes(`path: '${BASE}NitroAI-mac-arm64.zip'`));
  const win = fs.readFileSync(f('feed/latest.yml'), 'utf8');
  assert.ok(win.includes(`url: '${BASE}NitroAI-Setup-Windows.exe'`));
  assert.ok(win.includes(`sha512: '${sha512(f('NitroAI-Setup-Windows.exe'))}'`));
});

test('write: an installer that carries another version is refused', () => {
  const d = tmp();
  const f = (n) => path.join(d, n);
  fs.writeFileSync(f('NitroAI-mac-arm64.zip'), macZip('0.2.6'));
  fs.writeFileSync(f('NitroAI-Setup-Windows.exe'), fakeExe('0.2.6'));
  const mac = runWrite(['--app', 'nitroai', '--version', '0.2.7', '--download-base', BASE, '--out', f('feed'), '--mac-zip', f('NitroAI-mac-arm64.zip')]);
  assert.equal(mac.status, 1);
  assert.match(mac.stderr, /NitroAI-mac-arm64\.zip carries version 0\.2\.6, not 0\.2\.7/);
  const win = runWrite(['--app', 'nitroai', '--version', '0.2.7', '--download-base', BASE, '--out', f('feed'), '--win', f('NitroAI-Setup-Windows.exe')]);
  assert.equal(win.status, 1);
  assert.match(win.stderr, /NitroAI-Setup-Windows\.exe carries version 0\.2\.6, not 0\.2\.7/);
  assert.ok(!fs.existsSync(f('feed/latest.yml')));
});

test('write: two zips for the same arch are refused', () => {
  const d = tmp();
  const f = (n) => path.join(d, n);
  fs.writeFileSync(f('NitroAI-mac-arm64.zip'), macZip('0.2.7'));
  fs.writeFileSync(f('NitroAI-mac-arm64-copy.zip'), macZip('0.2.7'));
  const r = runWrite(['--app', 'nitroai', '--version', '0.2.7', '--download-base', BASE, '--out', f('feed'), '--mac-zip', f('NitroAI-mac-arm64.zip'), '--mac-zip', f('NitroAI-mac-arm64-copy.zip')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /two mac files for the same arch/);
});
