#!/usr/bin/env node
// publik-update-feed.cjs — makes the signed update feed of a release (docs/updates.md).
//
//   write    latest.yml (Windows) and/or latest-mac.yml (macOS) for files on disk, with ABSOLUTE
//            download URLs (the GitHub release assets). --mac-zip and --mac-dmg may repeat (one per arch):
//              node scripts/publik-update-feed.cjs write --app nitroai --version 0.2.7 \
//                --download-base https://github.com/OWNER/REPO/releases/download/v0.2.7/ \
//                --win release/NitroAI-Setup-Windows.exe \
//                --mac-zip release/NitroAI-mac-arm64.zip --mac-zip release/NitroAI-mac-x64.zip \
//                --mac-dmg release/NitroAI-mac-arm64.dmg --mac-dmg release/NitroAI-mac-x64.dmg --out feed
//   sign     signs each file with the publik update key (writes <file>.sig), then verifies the signature
//            with the public key in publik-update-verify.cjs. The key comes from the environment:
//            PUBLIK_UPDATE_KEY (the private key as `tauri signer generate` wrote it) and
//            PUBLIK_UPDATE_KEY_PASSWORD. It is never printed.
//              node scripts/publik-update-feed.cjs sign feed/latest.yml feed/latest-mac.yml
//   verify   checks <file> against <file>.sig with the publik update public key (or --public-key).
//   release  the CI path (.github/workflows/update-feed.yml): for the GitHub release --tag, makes every
//            feed file that is missing (all of them with --force) from the installer files on the
//            release, signs it, verifies it and uploads it. Uses the gh CLI.
//              node scripts/publik-update-feed.cjs release --tag v0.2.7 --app nitroai [--repo OWNER/REPO] [--version 0.2.7] [--force]
//
// A feed file is what electron-updater reads (version, files[] with url + sha512 + size, path, sha512,
// releaseDate), plus `publikApp: <slug>`: the app refuses a feed made for another app.
//
// Every installer must carry the feed's version, or the app would download it again at every check. A
// file whose NAME has the version passes. NitroAI's names do not (NitroAI-mac-arm64.zip, the README links
// to them), so the script reads the version INSIDE the file: CFBundleShortVersionString of the app in a
// mac zip, ProductVersion of a Windows installer. A dmg is only listed (the app never downloads it).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('../electron/publik-update-verify.cjs');

const TAURI_CLI = '@tauri-apps/cli@2.12.4';

function die(msg) {
  console.error(`publik-update-feed: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? true : (i++, next);
      opts[key] = key in opts ? [].concat(opts[key], value) : value; // a repeated flag gives a list
    } else opts._.push(a);
  }
  return opts;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // a YAML single-quoted string

function fileEntry(file, downloadBase) {
  const data = fs.readFileSync(file);
  const name = path.basename(file);
  return {
    name,
    url: new URL(encodeURIComponent(name), downloadBase).href,
    sha512: crypto.createHash('sha512').update(data).digest('base64'),
    size: data.length,
  };
}

/** The text of one feed file. The first entry is the one `path`/`sha512` name (electron-updater's legacy fields). */
function feedText({ app, version, entries, releaseDate }) {
  const lines = [`version: ${q(version)}`, `publikApp: ${q(app)}`, 'files:'];
  for (const e of entries) lines.push(`  - url: ${q(e.url)}`, `    sha512: ${q(e.sha512)}`, `    size: ${e.size}`);
  lines.push(`path: ${q(entries[0].url)}`, `sha512: ${q(entries[0].sha512)}`, `releaseDate: ${q(releaseDate)}`);
  return lines.join('\n') + '\n';
}

/** One entry of a zip file (central directory, stored or deflated, zip64 sizes), or null. */
function zipEntry(zip, match) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  if ((p === 0xffffffff || count === 0xffff) && eocd >= 20 && zip.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(zip.readBigUInt64LE(eocd - 12));
    if (zip.readUInt32LE(z64) !== 0x06064b50) return null;
    count = Number(zip.readBigUInt64LE(z64 + 32));
    p = Number(zip.readBigUInt64LE(z64 + 48));
  }
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    let size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    let local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (match(name)) {
      // zip64 extra field (0x0001): the 64-bit sizes and offset, in this order, for each 32-bit field that is 0xffffffff
      for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
        const id = zip.readUInt16LE(e);
        const len = zip.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let f = e + 4;
          if (zip.readUInt32LE(p + 24) === 0xffffffff) f += 8; // uncompressed size
          if (size === 0xffffffff) { size = Number(zip.readBigUInt64LE(f)); f += 8; }
          if (local === 0xffffffff) local = Number(zip.readBigUInt64LE(f));
        }
        e += 4 + len;
      }
      if (zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + size);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * The version a file carries inside it, or null:
 *   .zip  CFBundleShortVersionString of <Name>.app/Contents/Info.plist (electron-builder: the app version)
 *   .exe  the first ProductVersion string of the PE version resource (electron-builder's NSIS installer:
 *         the app version; the uninstaller and the app inside are compressed, so they do not show)
 */
function embeddedVersion(file) {
  const data = fs.readFileSync(file);
  if (/\.zip$/i.test(file)) {
    const plist = zipEntry(data, (name) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(name));
    const m = plist && /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist.toString('utf8'));
    return m ? m[1] : null;
  }
  if (/\.exe$/i.test(file)) {
    const key = Buffer.from('ProductVersion\0', 'utf16le');
    const at = data.indexOf(key);
    if (at < 0) return null;
    let i = at + key.length;
    while (i + 1 < data.length && data[i] === 0 && data[i + 1] === 0) i += 2; // padding to 32 bits
    let end = i;
    while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0) && end - i < 256) end += 2;
    return data.subarray(i, end).toString('utf16le') || null;
  }
  return null;
}

/** The file must be for `version`: its name says so, or (zip, exe) the version inside it does. */
function checkVersion(file, version) {
  const name = path.basename(file);
  if (name.includes(version)) return;
  const inside = embeddedVersion(file);
  if (inside !== version) die(`${name} carries version ${inside ?? '(none found)'}, not ${version}: is it the right file?`);
  console.log(`publik-update-feed: ${name} carries version ${inside}`);
}

/** The arch a mac file name names: arm64, x64 or universal (electron-builder's ${arch}). */
const macArch = (name) => (/(arm64|x64|universal)/i.exec(name) || [])[1] || 'universal';

const list = (v) => (v == null || v === true ? [] : [].concat(v));

function write(opts) {
  const { app, version, out } = opts;
  const base = opts['download-base'];
  if (!app || !version || !base || !out) die('write needs --app, --version, --download-base and --out');
  if (!/^https:\/\//.test(base)) die('--download-base must be an https URL');
  const downloadBase = base.endsWith('/') ? base : `${base}/`;
  const releaseDate = opts['release-date'] || new Date().toISOString();
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  if (opts.win) {
    if (Array.isArray(opts.win)) die('give one --win installer');
    checkVersion(opts.win, version);
    const text = feedText({ app, version, entries: [fileEntry(opts.win, downloadBase)], releaseDate });
    fs.writeFileSync(path.join(out, 'latest.yml'), text);
    written.push(path.join(out, 'latest.yml'));
  }
  const zips = list(opts['mac-zip']);
  const dmgs = list(opts['mac-dmg']);
  if (zips.length) {
    // The zips first, one per arch (Squirrel.Mac installs from a zip; electron-updater picks the arm64 file
    // on Apple silicon and a file without "arm64" in its name on Intel). The dmgs are listed after them.
    for (const group of [zips, dmgs]) {
      const archs = group.map((f) => macArch(path.basename(f)));
      if (new Set(archs).size !== archs.length) die(`two mac files for the same arch: ${group.map((f) => path.basename(f)).join(', ')}`);
    }
    for (const f of zips) checkVersion(f, version);
    const entries = [...zips, ...dmgs].map((f) => fileEntry(f, downloadBase));
    fs.writeFileSync(path.join(out, 'latest-mac.yml'), feedText({ app, version, entries, releaseDate }));
    written.push(path.join(out, 'latest-mac.yml'));
  } else if (dmgs.length) {
    die('--mac-dmg needs --mac-zip: macOS updates install from the zip');
  }
  if (!written.length) die('nothing to write: give --win and/or --mac-zip');
  for (const f of written) console.log(`publik-update-feed: wrote ${f}`);
  return written;
}

function publicKeyFrom(opts) {
  const k = opts['public-key'];
  if (!k || k === true) return PUBLIK_UPDATE_PUBLIC_KEYS;
  return fs.existsSync(k) ? fs.readFileSync(k, 'utf8') : k;
}

function verify(files, opts) {
  const key = publicKeyFrom(opts);
  for (const f of files) {
    const sigFile = `${f}.sig`;
    if (!fs.existsSync(sigFile)) die(`${sigFile} is missing`);
    try {
      const v = verifyMinisign(fs.readFileSync(f), fs.readFileSync(sigFile, 'utf8'), key, { file: path.basename(f) });
      console.log(`publik-update-feed: ${path.basename(sigFile)} OK (key ${v.keyId}, ${v.trustedComment.replace(/\t/g, ' ')})`);
    } catch (e) {
      die(`${path.basename(sigFile)} does not verify: ${e.message}`);
    }
  }
}

function sign(files, opts) {
  const key = process.env.PUBLIK_UPDATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY;
  const password = process.env.PUBLIK_UPDATE_KEY_PASSWORD ?? process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  if (!key) die('PUBLIK_UPDATE_KEY is not set');
  if (!password) die('PUBLIK_UPDATE_KEY_PASSWORD is not set');
  const env = { ...process.env, CI: 'true', TAURI_SIGNING_PRIVATE_KEY: key.trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  for (const f of files) {
    if (!fs.existsSync(f)) die(`${f} does not exist`);
    fs.rmSync(`${f}.sig`, { force: true });
    const r = spawnSync('npx', ['--yes', TAURI_CLI, 'signer', 'sign', f], { env, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
    if (r.status !== 0 || !fs.existsSync(`${f}.sig`)) die(`signing ${f} failed (exit ${r.status})`);
  }
  verify(files, opts);
}

function gh(args, { json = false } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) die(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.status})`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

function release(opts) {
  const tag = opts.tag;
  const app = opts.app;
  const repo = opts.repo || process.env.GITHUB_REPOSITORY;
  if (!tag || !app || !repo) die('release needs --tag, --app and --repo (or GITHUB_REPOSITORY)');
  const version = opts.version || tag.replace(/^v/, ''); // --version: when the tag is not v<version>
  const rel = gh(['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft'], { json: true });
  const names = rel.assets.map((a) => a.name);
  // The installer files on the release. Names that carry the version win over names that do not.
  const pick = (re) => {
    const hits = names.filter((n) => re.test(n));
    const withVersion = hits.filter((n) => n.includes(version));
    return withVersion.length ? withVersion : hits;
  };
  const exes = pick(/\.exe$/i);
  if (exes.length > 1) die(`more than one Windows installer on ${tag}: ${exes.join(', ')}`);
  const exe = exes[0];
  const zips = pick(/-mac-.*\.zip$/i);
  const dmgs = pick(/-mac-.*\.dmg$/i);
  const jobs = [];
  if (exe && (opts.force || !names.includes('latest.yml'))) jobs.push({ feed: 'latest.yml', files: [exe] });
  if (zips.length && (opts.force || !names.includes('latest-mac.yml'))) jobs.push({ feed: 'latest-mac.yml', zips, dmgs });
  if (!exe) console.log(`publik-update-feed: ${tag} has no Windows installer yet: no latest.yml`);
  if (!zips.length) console.log(`publik-update-feed: ${tag} has no mac zip yet: no latest-mac.yml (upload the zips, then run this again)`);
  if (!jobs.length) { console.log(`publik-update-feed: nothing to do for ${tag}`); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publik-feed-'));
  const bin = path.join(dir, 'assets');
  const out = path.join(dir, 'feed');
  const wanted = [...new Set(jobs.flatMap((j) => [...(j.files || []), ...(j.zips || []), ...(j.dmgs || [])]))];
  gh(['release', 'download', tag, '--repo', repo, '--dir', bin, ...wanted.flatMap((n) => ['--pattern', n])]);
  const w = { app, version, out, 'download-base': `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/` };
  for (const j of jobs) {
    if (j.feed === 'latest.yml') w.win = path.join(bin, j.files[0]);
    else { w['mac-zip'] = j.zips.map((n) => path.join(bin, n)); w['mac-dmg'] = j.dmgs.map((n) => path.join(bin, n)); }
  }
  const feeds = write(w);
  sign(feeds, opts);
  const upload = feeds.flatMap((f) => [f, `${f}.sig`]);
  gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...upload]); // --clobber touches only the feed files
  console.log(`publik-update-feed: uploaded ${upload.map((f) => path.basename(f)).join(', ')} to ${tag}${rel.isDraft ? ' (draft)' : ''}`);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === 'write') write(opts);
  else if (cmd === 'sign') sign(opts._, opts);
  else if (cmd === 'verify') verify(opts._, opts);
  else if (cmd === 'release') release(opts);
  else die('usage: publik-update-feed.cjs write|sign|verify|release ... (see the top of this file)');
}

module.exports = { feedText, fileEntry, write, embeddedVersion, zipEntry };
