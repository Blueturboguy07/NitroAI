#!/usr/bin/env bash
# publik-release.sh — cut a NitroAI release with ONE command (docs/updates.md › Cut a release).
#
#   scripts/publik-release.sh 0.2.8                 the whole release: see the steps below
#   scripts/publik-release.sh 0.2.8 --no-publish    the same, but stop before publishing (the draft stays)
#   scripts/publik-release.sh 0.2.7 --verify-only   only download and check a release that exists (draft or public)
#
# NitroAI signs in CI: the repo has the Developer ID certificate, the Apple notary login and the publik update
# key as secrets. So this script does not sign on this Mac. It drives the CI and checks what comes out:
#   1. checks: macOS with gh logged in, branch main, clean tree, main = origin/main, the version is newer
#      than package.json and every release, the tag vX.Y.Z is free (local, remote, no release yet).
#   2. bump: package.json and package-lock.json (its two version fields). Nothing else carries the version.
#      One commit, pushed to main; then the tag vX.Y.Z, pushed. No force push.
#   3. CI: the tag starts .github/workflows/release.yml. It builds the mac apps (arm64, x64), signs them with
#      the Developer ID (hardened runtime, build-resources/entitlements.mac.plist; electron-builder signs the
#      inner binaries first), notarizes and staples them, builds and notarizes + staples the dmgs, makes the
#      zips, the Windows installer and the AppImage, puts them all on a DRAFT release, and then (update-feed.yml)
#      writes latest.yml / latest-mac.yml with absolute GitHub URLs and signs them with the publik update key.
#      The script waits for it (a failed run: its failed jobs are run again once; a missing feed: update-feed.yml).
#   4. verify, on this Mac, from the draft (each file downloaded, checked and deleted before the next one):
#      exactly the 10 expected files; the feed signatures with the app's own verifier and public key; feed
#      version, app slug, absolute URLs, sizes and sha512 = the files; GitHub's sha256 of every file; in each mac
#      zip and dmg: Info.plist version, bundle ID, arch, codesign --verify --deep --strict, Developer ID
#      authority + team, hardened runtime, the entitlements, the designated requirement, spctl ("Notarized
#      Developer ID"), stapler, the publik app token, not a test build; the same app (CDHash) in zip and dmg;
#      the Windows installer's version; the app token on every OS (the build logs).
#   5. publish: only when every check passed. Then it checks the release is public.
# Any failed check stops the script before step 5. Run it again with the same version: it picks up where it
# stopped (a pushed bump, a pushed tag, a running or failed CI run, a draft without its feed).
#
# It starts no app and prints no secret: the signing keys stay in the repo secrets, and the app token is
# checked but not printed. A Mac without the CI path would sign locally (Developer ID in the keychain,
# `notarytool --keychain-profile publik`); NitroAI does not need that.
#
# Env: PUBLIK_RELEASE_WORK (work folder, default $TMPDIR/publik-release-nitroai),
#      PUBLIK_RELEASE_MIN_FREE_GB (free disk needed to start, default 1.5),
#      RELEASE_COMMIT_TRAILER (a line added to the bump commit message, e.g. a Co-Authored-By trailer).
set -euo pipefail

APP_NAME=NitroAI
SLUG=nitroai
BUNDLE_ID=com.nitroai.app
TEAM_ID=R5R3ZS54LV
DEV_ID="Developer ID Application: Mann Bellani ($TEAM_ID)"
RELEASE_BRANCH=main
RELEASE_WORKFLOW=release.yml
FEED_WORKFLOW=update-feed.yml
MAC_ZIPS="NitroAI-mac-arm64.zip NitroAI-mac-x64.zip"
MAC_DMGS="NitroAI-mac-arm64.dmg NitroAI-mac-x64.dmg"
WIN_EXE=NitroAI-Setup-Windows.exe
LINUX_APPIMAGE=NitroAI-Linux-x86_64.AppImage
FEEDS="latest.yml latest-mac.yml"
EXPECTED_ASSETS="$MAC_ZIPS $MAC_DMGS $WIN_EXE $LINUX_APPIMAGE latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig"
EXPECTED_DR="identifier \"$BUNDLE_ID\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = $TEAM_ID"
CI_TIMEOUT_MIN=120

usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 1 ] || usage
VERSION="$1"; shift
MODE=release
for a in "$@"; do
  case "$a" in
    --no-publish) MODE=no-publish ;;
    --verify-only) MODE=verify-only ;;
    *) usage ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3, not $VERSION" >&2; exit 2; }
TAG="v$VERSION"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WORK="${PUBLIK_RELEASE_WORK:-${TMPDIR:-/tmp}/publik-release-$SLUG}/$TAG"
mkdir -p "$WORK"
LOG="$WORK/release.log"
exec > >(tee -a "$LOG") 2>&1
CHECKS="$WORK/checks.txt"
: > "$CHECKS"

say() { printf '\n==== %s\n' "$*"; }
ok() { echo "  ok  $*" | tee -a "$CHECKS"; }
die() {
  local again="scripts/publik-release.sh $VERSION"
  [ "$MODE" = release ] || again="$again --$MODE"
  echo "STOP: $*" | tee -a "$CHECKS" >&2
  echo "Nothing was published. Fix the cause, then run again: $again" >&2
  exit 1
}
cleanup() { [ -n "${MOUNTED:-}" ] && hdiutil detach "$MOUNTED" -force -quiet 2>/dev/null; rm -rf "$WORK/bin" "$WORK/x" "$WORK/mnt"; }
trap cleanup EXIT

# Numeric version compare: prints -1, 0 or 1.
vcmp() { node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));for(let i=0;i<3;i++){if(a[i]!==b[i]){console.log(a[i]<b[i]?-1:1);process.exit()}}console.log(0)' "$1" "$2"; }
free_bytes() { df -k "$WORK" | awk 'NR==2 { print $4 * 1024 }'; }
need_disk() { # bytes, what
  local free; free="$(free_bytes)"
  [ "$free" -ge "$1" ] || die "not enough disk for $2: $((free / 1048576)) MB free, $(($1 / 1048576)) MB needed"
}

# ---------- 1. checks ----------
say "$APP_NAME $TAG ($MODE)"
[ "$(uname -s)" = Darwin ] || die "run this on a Mac (the checks use codesign, spctl, stapler, hdiutil)"
for t in gh git node curl codesign spctl xcrun hdiutil ditto lipo openssl shasum; do command -v "$t" >/dev/null || die "$t is missing"; done
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo "repo $REPO, work folder $WORK"
git fetch -q origin "$RELEASE_BRANCH" --tags

# The release on GitHub for this tag: "none", "draft" or "public". Two releases with one tag: stop.
release_state() {
  local rows
  rows="$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .draft")"
  case "$(printf '%s\n' "$rows" | grep -c .)" in
    0) echo none ;;
    1) [ "$rows" = true ] && echo draft || echo public ;;
    *) die "more than one release has the tag $TAG: delete the extra drafts on GitHub, then run again" ;;
  esac
}
STATE="$(release_state)"
REMOTE_TAG_SHA="$(git ls-remote origin "refs/tags/$TAG^{}" | cut -f1)"
[ -n "$REMOTE_TAG_SHA" ] || REMOTE_TAG_SHA="$(git ls-remote origin "refs/tags/$TAG" | cut -f1)"
echo "release: $STATE; remote tag: ${REMOTE_TAG_SHA:-none}"

if [ "$MODE" = verify-only ]; then
  [ "$STATE" != none ] || die "there is no release $TAG to verify"
else
  free="$(free_bytes)"
  min="$(node -e "console.log(Math.round(${PUBLIK_RELEASE_MIN_FREE_GB:-1.5} * 1073741824))")"
  [ "$free" -ge "$min" ] || die "only $((free / 1048576)) MB free; a release needs ${PUBLIK_RELEASE_MIN_FREE_GB:-1.5} GB (PUBLIK_RELEASE_MIN_FREE_GB)"
  ok "disk: $((free / 1048576)) MB free"
fi

# ---------- 2. bump, commit, tag ----------
if [ "$MODE" != verify-only ] && [ -z "$REMOTE_TAG_SHA" ]; then
  [ "$STATE" = none ] || die "a release $TAG exists but the tag does not: delete that release on GitHub, then run again"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$RELEASE_BRANCH" ] || die "check out $RELEASE_BRANCH first"
  [ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
  CURRENT="$(node -p 'require("./package.json").version')"
  if [ "$CURRENT" = "$VERSION" ]; then
    # A bump commit from an earlier run. It must be the commit on top, and only the bump.
    [ "$(git log -1 --format=%s)" = "$VERSION: release" ] || die "package.json is already $VERSION but the last commit is not the bump of this script"
    changed="$(git show --format= --name-only HEAD | sort | tr '\n' ' ')"
    [ "$changed" = "package-lock.json package.json " ] || die "the bump commit changes more than the two version files: $changed"
    ok "bump commit of an earlier run: $(git rev-parse --short HEAD)"
  else
    [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$RELEASE_BRANCH")" ] || die "$RELEASE_BRANCH is not origin/$RELEASE_BRANCH: pull or push first"
    [ "$(vcmp "$VERSION" "$CURRENT")" = 1 ] || die "$VERSION is not newer than package.json ($CURRENT)"
    latest="$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq '.[].tag_name' | sed -n 's/^v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
    [ -z "$latest" ] || [ "$(vcmp "$VERSION" "$latest")" = 1 ] || die "$VERSION is not newer than the release v$latest"
    say "Bump $CURRENT -> $VERSION"
    node - "$VERSION" <<'JS'
const fs = require('fs');
const v = process.argv[2];
const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
const once = (text, re, file) => { if (!re.test(text)) throw new Error(`no version field in ${file}`); return text.replace(re, `$1${v}$2`); };
edit('package.json', (t) => once(t, /^(  "version": ")[^"]*(")/m, 'package.json'));
edit('package-lock.json', (t) => once(once(t, /^(  "version": ")[^"]*(")/m, 'package-lock.json'), /("packages": \{\s*"": \{[^}]*?"version": ")[^"]*(")/, 'package-lock.json'));
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const l = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
if (p.version !== v || l.version !== v || l.packages[''].version !== v) throw new Error('the bump did not set every version field');
JS
    stat="$(git diff --numstat | awk '{ print $3 ":" $1 "+" $2 "-" }' | sort | tr '\n' ' ')"
    [ "$stat" = "package-lock.json:2+2- package.json:1+1- " ] || { git checkout -- package.json package-lock.json; die "unexpected bump diff: $stat"; }
    git add package.json package-lock.json
    msg="$VERSION: release"
    if [ -n "${RELEASE_COMMIT_TRAILER:-}" ]; then
      git commit -q -m "$msg" -m "Version bump only (scripts/publik-release.sh)." -m "$RELEASE_COMMIT_TRAILER"
    else
      git commit -q -m "$msg" -m "Version bump only (scripts/publik-release.sh)."
    fi
    ok "bump commit $(git rev-parse --short HEAD): package.json, package-lock.json -> $VERSION"
  fi
  if [ "$(git rev-parse "origin/$RELEASE_BRANCH")" != "$(git rev-parse HEAD)" ]; then
    git merge-base --is-ancestor "origin/$RELEASE_BRANCH" HEAD || die "origin/$RELEASE_BRANCH moved: pull, then run again"
    git push -q origin "HEAD:refs/heads/$RELEASE_BRANCH"
    ok "pushed $RELEASE_BRANCH $(git rev-parse --short HEAD)"
  fi
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    [ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)" ] || die "a local tag $TAG points at another commit: delete it (git tag -d $TAG), then run again"
  else
    git tag -a "$TAG" -m "$APP_NAME $VERSION" HEAD
  fi
  git push -q origin "refs/tags/$TAG"
  REMOTE_TAG_SHA="$(git rev-parse HEAD)"
  ok "pushed tag $TAG -> $(git rev-parse --short HEAD)"
fi

if [ -n "$REMOTE_TAG_SHA" ]; then
  git fetch -q origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
  tagged_version="$(git show "$REMOTE_TAG_SHA:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
  [ "$tagged_version" = "$VERSION" ] || die "the tag $TAG points at a commit whose package.json is $tagged_version"
  git merge-base --is-ancestor "$REMOTE_TAG_SHA" "origin/$RELEASE_BRANCH" || die "the tag $TAG is not on origin/$RELEASE_BRANCH"
  ok "tag $TAG = $(git rev-parse --short "$REMOTE_TAG_SHA") on $RELEASE_BRANCH, package.json $tagged_version"
fi

# ---------- 3. CI ----------
wait_run() { # run id, what
  local id="$1" what="$2" end=$(( $(date +%s) + CI_TIMEOUT_MIN * 60 )) last="" now
  while :; do
    now="$(gh run view "$id" -R "$REPO" --json status,conclusion,jobs --jq '"\(.status) \(.conclusion) | " + ([.jobs[] | "\(.name)=\(if .status == "completed" then .conclusion else .status end)"] | join(", "))')"
    [ "$now" != "$last" ] && echo "  $(date -u +%H:%M:%S) $what: $now" && last="$now"
    case "$now" in completed*) break ;; esac
    [ "$(date +%s)" -lt "$end" ] || die "$what did not finish in $CI_TIMEOUT_MIN minutes: https://github.com/$REPO/actions/runs/$id"
    sleep 90 # one gh call per 90 s: the GitHub API limit is shared
  done
  [ "$(gh run view "$id" -R "$REPO" --json conclusion --jq .conclusion)" = success ]
}
find_run() { gh run list -R "$REPO" --workflow "$RELEASE_WORKFLOW" --event push --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId // empty'; }
CI_RUN="$(find_run)"
if [ "$STATE" != public ] && [ "$MODE" != verify-only ]; then
  say "CI: $RELEASE_WORKFLOW for $TAG"
  t=0
  while [ -z "$CI_RUN" ]; do
    [ "$t" -lt 360 ] || die "no $RELEASE_WORKFLOW run started for the tag $TAG"
    sleep 90; t=$((t + 90))
    CI_RUN="$(find_run)"
  done
  run_sha="$(gh run view "$CI_RUN" -R "$REPO" --json headSha --jq .headSha)"
  [ "$run_sha" = "$REMOTE_TAG_SHA" ] || die "the CI run $CI_RUN built $run_sha, not the tag's commit $REMOTE_TAG_SHA"
  echo "  https://github.com/$REPO/actions/runs/$CI_RUN"
  if ! wait_run "$CI_RUN" "$RELEASE_WORKFLOW"; then
    attempts="$(gh run view "$CI_RUN" -R "$REPO" --json attempt --jq .attempt)"
    [ "$attempts" -lt 2 ] || die "the CI run failed again (attempt $attempts): https://github.com/$REPO/actions/runs/$CI_RUN"
    echo "  the run failed; running its failed jobs again (once)"
    gh run rerun "$CI_RUN" -R "$REPO" --failed
    sleep 90
    wait_run "$CI_RUN" "$RELEASE_WORKFLOW (attempt 2)" || die "the CI run failed: https://github.com/$REPO/actions/runs/$CI_RUN"
  fi
  ok "CI run $CI_RUN succeeded (build, sign, notarize, draft, feed)"
  STATE="$(release_state)"
  [ "$STATE" != none ] || die "the CI run succeeded but there is no release $TAG"
fi

# A draft that misses feed files (the feed job failed or was skipped): update-feed.yml makes them.
assets_tsv() { gh api "repos/$REPO/releases/$RELEASE_ID" --jq '.assets[] | "\(.name)\t\(.size)\t\(.state)\t\(.digest // "")\t\(.id)"'; }
RELEASE_ID="$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .id")"
missing_feed=""
for f in latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig; do assets_tsv | cut -f1 | grep -qx "$f" || missing_feed="$missing_feed $f"; done
if [ -n "$missing_feed" ] && [ "$STATE" = draft ] && [ "$MODE" != verify-only ]; then
  say "The draft misses$missing_feed: $FEED_WORKFLOW"
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gh workflow run "$FEED_WORKFLOW" -R "$REPO" --ref "$RELEASE_BRANCH" -f tag="$TAG"
  t=0
  while :; do
    sleep 90; t=$((t + 90))
    feed_run="$(gh run list -R "$REPO" --workflow "$FEED_WORKFLOW" --event workflow_dispatch --limit 5 --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")"
    [ -n "$feed_run" ] && break
    [ "$t" -lt 360 ] || die "the $FEED_WORKFLOW run did not start"
  done
  wait_run "$feed_run" "$FEED_WORKFLOW" || die "$FEED_WORKFLOW failed: https://github.com/$REPO/actions/runs/$feed_run"
  ok "feed files added by $FEED_WORKFLOW run $feed_run"
fi

# ---------- 4. verify ----------
say "Verify the $STATE release $TAG (downloaded back from GitHub)"
assets_tsv > "$WORK/assets.tsv"
cat "$WORK/assets.tsv"
have="$(cut -f1 "$WORK/assets.tsv" | sort | tr '\n' ' ')"
want="$(printf '%s\n' $EXPECTED_ASSETS | sort | tr '\n' ' ')"
[ "$have" = "$want" ] || die "the release files are not the expected ones. Have: $have Want: $want"
awk -F'\t' '$3 != "uploaded" || $2 == 0 { bad = bad " " $1 } END { if (bad) { print "not uploaded or empty:" bad; exit 1 } }' "$WORK/assets.tsv" || die "a release file is incomplete"
ok "the release holds exactly the 10 expected files, all uploaded"
asset_field() { awk -F'\t' -v n="$1" -v c="$2" '$1 == n { print $c }' "$WORK/assets.tsv"; }
download() { # name -> path (one file at a time; the caller deletes it). By asset ID: works for a draft too.
  rm -rf "$WORK/bin"; mkdir -p "$WORK/bin"
  gh api -H 'Accept: application/octet-stream' "repos/$REPO/releases/assets/$(asset_field "$1" 5)" > "$WORK/bin/$1" || die "download of $1 failed"
  local size; size="$(stat -f %z "$WORK/bin/$1")"
  [ "$size" = "$(asset_field "$1" 2)" ] || die "$1: downloaded $size bytes, the release says $(asset_field "$1" 2)"
  local digest; digest="$(asset_field "$1" 4)"
  if [ -n "$digest" ]; then
    [ "sha256:$(shasum -a 256 "$WORK/bin/$1" | cut -d' ' -f1)" = "$digest" ] || die "$1: sha256 is not GitHub's $digest"
  fi
  echo "$WORK/bin/$1"
}

# The app's own verifier needs blakejs; a clone without node_modules gets it in the work folder.
if ! node -e "require.resolve('blakejs', { paths: ['$ROOT/electron'] })" >/dev/null 2>&1; then
  [ -d "$WORK/npm/node_modules/blakejs" ] || npm install --silent --no-save --no-package-lock --no-audit --no-fund --prefix "$WORK/npm" blakejs@1.2.1 >/dev/null
  export NODE_PATH="$WORK/npm/node_modules"
fi
mkdir -p "$WORK/feed"
for f in latest.yml latest-mac.yml; do
  for g in "$f" "$f.sig"; do cp "$(download "$g")" "$WORK/feed/$g"; done
done
node scripts/publik-update-feed.cjs verify "$WORK/feed/latest.yml" "$WORK/feed/latest-mac.yml" | sed 's/^/  /' | tee -a "$CHECKS" \
  || die "a feed signature does not verify with the app's public key"
ok "feed signatures verify with the app's public key (electron/publik-update-verify.cjs)"

# Feed contents: version, slug, absolute URLs in the expected order, sizes; prints "name sha512" lines.
feed_check() { # feed file, expected names...
  node - "$@" "$VERSION" "$SLUG" "https://github.com/$REPO/releases/download/$TAG/" "$WORK/assets.tsv" <<'JS'
const fs = require('fs');
const a = process.argv.slice(2);
const [assetsFile, base, slug, version] = [a.pop(), a.pop(), a.pop(), a.pop()];
const [file, ...names] = a;
const t = fs.readFileSync(file, 'utf8');
const field = (k) => (new RegExp(`^${k}: '([^']*)'$`, 'm').exec(t) || [])[1];
const files = [...t.matchAll(/^  - url: '([^']*)'\n    sha512: '([^']*)'\n    size: (\d+)$/gm)].map((m) => ({ url: m[1], sha512: m[2], size: Number(m[3]) }));
const sizes = Object.fromEntries(fs.readFileSync(assetsFile, 'utf8').trim().split('\n').map((l) => l.split('\t')).map(([n, s]) => [n, Number(s)]));
const fail = (m) => { console.error(`${file}: ${m}`); process.exit(1); };
if (field('version') !== version) fail(`version ${field('version')}, not ${version}`);
if (field('publikApp') !== slug) fail(`publikApp ${field('publikApp')}, not ${slug}`);
if (files.length !== names.length) fail(`${files.length} files, not ${names.length}`);
names.forEach((n, i) => {
  const f = files[i];
  if (f.url !== base + n) fail(`file ${i + 1} is ${f.url}, not ${base + n}`);
  if (f.size !== sizes[n]) fail(`${n}: size ${f.size}, the release file has ${sizes[n]}`);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(f.sha512)) fail(`${n}: bad sha512`);
});
if (field('path') !== files[0].url || field('sha512') !== files[0].sha512) fail('path/sha512 are not the first file');
if (!field('releaseDate')) fail('no releaseDate');
for (const [i, n] of names.entries()) console.log(`${n} ${files[i].sha512}`);
JS
}
feed_check "$WORK/feed/latest.yml" "$WIN_EXE" > "$WORK/feed-sha512.txt" || die "latest.yml is wrong"
feed_check "$WORK/feed/latest-mac.yml" $MAC_ZIPS $MAC_DMGS >> "$WORK/feed-sha512.txt" || die "latest-mac.yml is wrong"
ok "feeds: version $VERSION, publikApp $SLUG, absolute URLs https://github.com/$REPO/releases/download/$TAG/..., sizes = the release files"
feed_sha512() { awk -v n="$1" '$1 == n { print $2 }' "$WORK/feed-sha512.txt"; }
sha512_b64() { openssl dgst -sha512 -binary "$1" | base64; }

# The publik app token in the packaged package.json of app.asar: checked, never printed.
asar_package() { # app.asar -> "version appTokenState testBuild"
  node - "$1" <<'JS'
const fs = require('fs');
const fd = fs.openSync(process.argv[2], 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4); // pickle: [4][header pickle size][payload size][string size][json]
const json = Buffer.alloc(head.readUInt32LE(12));
fs.readSync(fd, json, 0, json.length, 16);
const entry = JSON.parse(json.toString('utf8')).files['package.json'];
const data = Buffer.alloc(entry.size);
fs.readSync(fd, data, 0, entry.size, 8 + headerSize + Number(entry.offset));
const p = JSON.parse(data.toString('utf8'));
const tok = p.publik && p.publik.appToken;
const state = typeof tok === 'string' && tok.startsWith('pat_') ? `present(${tok.length}-chars)` : 'MISSING';
console.log(`${p.version} ${state} ${p.publikUpdaterTest === true ? 'TEST-BUILD' : 'release-build'}`);
JS
}

check_app() { # app path, arch (arm64|x64), what -> prints the CDHash
  local app="$1" arch="$2" what="$3" plist v id archs dv dr ent assess cdh pkg
  plist="$app/Contents/Info.plist"
  v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
  [ "$v" = "$VERSION" ] || die "$what: Info.plist version $v, not $VERSION"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")" = "$VERSION" ] || die "$what: CFBundleVersion is not $VERSION"
  [ "$id" = "$BUNDLE_ID" ] || die "$what: bundle ID $id"
  archs="$(lipo -archs "$app/Contents/MacOS/$APP_NAME")"
  [ "$archs" = "$([ "$arch" = x64 ] && echo x86_64 || echo arm64)" ] || die "$what: the binary is $archs"
  codesign --verify --deep --strict "$app" 2>"$WORK/codesign.err" || die "$what: codesign --verify --deep --strict: $(cat "$WORK/codesign.err")"
  dv="$(codesign -dvv "$app" 2>&1)"
  printf '%s\n' "$dv" | grep -qx "Authority=$DEV_ID" || die "$what: not signed by $DEV_ID"
  printf '%s\n' "$dv" | grep -qx "TeamIdentifier=$TEAM_ID" || die "$what: team is not $TEAM_ID"
  printf '%s\n' "$dv" | grep -q '^Timestamp=' || die "$what: no secure timestamp"
  printf '%s\n' "$dv" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(runtime\)' || die "$what: no hardened runtime"
  # Inner code (helpers, frameworks): the same Developer ID and the hardened runtime.
  local inner n=0
  while IFS= read -r inner; do
    # Read codesign's answer into a variable first: with pipefail, `codesign | grep -q` fails by chance when
    # grep closes the pipe before codesign has written every line.
    local idv; idv="$(codesign -dvv "$inner" 2>&1 || true)"
    printf '%s\n' "$idv" | grep -x "Authority=$DEV_ID" >/dev/null || die "$what: $(basename "$inner") is not signed by $DEV_ID"
    case "$inner" in *.app) printf '%s\n' "$idv" | grep '(runtime)' >/dev/null || die "$what: $(basename "$inner") has no hardened runtime" ;; esac
    n=$((n + 1))
  done < <(find "$app/Contents/Frameworks" -maxdepth 1 \( -name '*.app' -o -name '*.framework' \))
  [ "$n" -gt 0 ] || die "$what: no inner code found"
  dr="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
  [ "$dr" = "$EXPECTED_DR" ] || die "$what: designated requirement is \"$dr\""
  ent="$(codesign -d --entitlements :- "$app" 2>/dev/null)"
  node -e '
    const want = require("child_process").execFileSync("plutil", ["-convert", "json", "-o", "-", process.argv[1]]).toString();
    const have = require("child_process").execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: process.argv[2] }).toString();
    const w = JSON.parse(want), h = JSON.parse(have);
    for (const k of Object.keys(w)) if (h[k] !== w[k]) { console.error("entitlement " + k + " is " + h[k]); process.exit(1); }' \
    "$ROOT/build-resources/entitlements.mac.plist" "$ent" || die "$what: the entitlements are not build-resources/entitlements.mac.plist"
  assess="$(spctl -a -t exec -vv "$app" 2>&1 || true)"
  printf '%s\n' "$assess" | grep -q ': accepted$' && printf '%s\n' "$assess" | grep -qx 'source=Notarized Developer ID' \
    || die "$what: Gatekeeper says: $(echo $assess)"
  xcrun stapler validate "$app" >/dev/null 2>&1 || die "$what: no stapled ticket"
  pkg="$(asar_package "$app/Contents/Resources/app.asar")"
  case "$pkg" in "$VERSION present("*") release-build") ;; *) die "$what: app.asar package.json: $pkg" ;; esac
  grep -q "url: https://publikhq.com/api/updates/$SLUG/" "$app/Contents/Resources/app-update.yml" || die "$what: app-update.yml does not name the publik feed"
  cdh="$(codesign -dvvv "$app" 2>&1 | sed -n 's/^CDHash=//p')"
  [ -n "$cdh" ] || die "$what: no CDHash"
  ok "$what: $VERSION, $BUNDLE_ID, $archs, Developer ID $TEAM_ID + timestamp + hardened runtime ($n inner items too), entitlements, designated requirement, Gatekeeper \"Notarized Developer ID\", stapled, app token ${pkg#* }" >&2
  echo "$cdh"
}

CDHASHES=""
for zip in $MAC_ZIPS; do
  arch="${zip#NitroAI-mac-}"; arch="${arch%.zip}"
  need_disk $(( $(asset_field "$zip" 2) * 4 + 314572800 )) "$zip"
  f="$(download "$zip")"
  [ "$(sha512_b64 "$f")" = "$(feed_sha512 "$zip")" ] || die "$zip: sha512 is not the feed's"
  ok "$zip: size, GitHub sha256 and the feed's sha512 match"
  rm -rf "$WORK/x"; mkdir -p "$WORK/x"
  ditto -x -k "$f" "$WORK/x"
  rm -f "$f"
  [ -d "$WORK/x/$APP_NAME.app" ] || die "$zip holds no $APP_NAME.app"
  cdhash="$(check_app "$WORK/x/$APP_NAME.app" "$arch" "$zip")"
  CDHASHES="$CDHASHES $arch=$cdhash"
  rm -rf "$WORK/x"
done
need_disk $(( $(asset_field "$WIN_EXE" 2) + 104857600 )) "$WIN_EXE"
f="$(download "$WIN_EXE")"
[ "$(sha512_b64 "$f")" = "$(feed_sha512 "$WIN_EXE")" ] || die "$WIN_EXE: sha512 is not the feed's"
exe_version="$(node -e 'console.log(require(process.argv[1]).embeddedVersion(process.argv[2]))' "$ROOT/scripts/publik-update-feed.cjs" "$f")"
[ "$exe_version" = "$VERSION" ] || die "$WIN_EXE carries version $exe_version"
rm -f "$f"
ok "$WIN_EXE: size, sha256, sha512 match; ProductVersion $exe_version (not code-signed: no Windows certificate)"

need_disk $(( $(asset_field "$LINUX_APPIMAGE" 2) + 104857600 )) "$LINUX_APPIMAGE"
f="$(download "$LINUX_APPIMAGE")"
[ "$(head -c 4 "$f" | xxd -p)" = 7f454c46 ] || die "$LINUX_APPIMAGE is not an ELF file"
rm -f "$f"
ok "$LINUX_APPIMAGE: size and sha256 match; ELF (no updater on Linux)"

# The app token on Windows and Linux: the build job says whether it had it (the token is not printed).
[ -n "$CI_RUN" ] || die "no $RELEASE_WORKFLOW run for $TAG: cannot check the app token of the Windows and Linux builds"
if [ -n "$CI_RUN" ]; then
  while IFS=$'\t' read -r job_id job_name; do
    # The step's output line (timestamp, then the text), not the echo command that the log also shows.
    gh api "repos/$REPO/actions/jobs/$job_id/logs" > "$WORK/job.log" 2>/dev/null || die "cannot read the log of the build job \"$job_name\""
    grep -Eq '^[0-9-]+T[0-9:.]+Z publik app token present \(not printed\)\.' "$WORK/job.log" \
      || die "the build job \"$job_name\" ran without the publik app token"
    rm -f "$WORK/job.log"
    ok "build job \"$job_name\": publik app token present"
  done < <(gh run view "$CI_RUN" -R "$REPO" --json jobs --jq '.jobs[] | select(.name | startswith("build")) | "\(.databaseId)\t\(.name)"')
fi

for dmg in $MAC_DMGS; do
  arch="${dmg#NitroAI-mac-}"; arch="${arch%.dmg}"
  need_disk $(( $(asset_field "$dmg" 2) + 314572800 )) "$dmg"
  f="$(download "$dmg")"
  [ "$(sha512_b64 "$f")" = "$(feed_sha512 "$dmg")" ] || die "$dmg: sha512 is not the feed's"
  xcrun stapler validate "$f" >/dev/null 2>&1 || die "$dmg: no stapled ticket"
  mkdir -p "$WORK/mnt"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$WORK/mnt" "$f" >/dev/null || die "$dmg does not mount"
  MOUNTED="$WORK/mnt"
  cdhash="$(check_app "$WORK/mnt/$APP_NAME.app" "$arch" "$dmg (the app inside)")"
  hdiutil detach "$WORK/mnt" -quiet || hdiutil detach "$WORK/mnt" -force -quiet
  MOUNTED=""
  case " $CDHASHES " in *" $arch=$cdhash "*) ok "$dmg holds the same app as NitroAI-mac-$arch.zip (CDHash $cdhash)" ;;
    *) die "$dmg holds another app than the $arch zip (CDHash $cdhash; zips:$CDHASHES)" ;; esac
  # The dmg's own signature: what Gatekeeper checks when a downloaded (quarantined) dmg is opened.
  local fdv; fdv="$(codesign -dvv "$f" 2>&1 || true)"
  printf '%s\n' "$fdv" | grep -x "Authority=$DEV_ID" >/dev/null || die "$dmg is not code-signed by $DEV_ID (release.yml signs it before notarizing)"
  codesign --verify "$f" 2>/dev/null || die "$dmg: its code signature does not verify"
  assess="$(spctl -a -t open --context context:primary-signature -vv "$f" 2>&1 || true)"
  printf '%s\n' "$assess" | grep -q ': accepted$' && printf '%s\n' "$assess" | grep -qx 'source=Notarized Developer ID' \
    || die "$dmg: Gatekeeper says: $(echo $assess)"
  rm -f "$f"
  ok "$dmg: size, sha256, sha512 match; signed by $DEV_ID; stapled; Gatekeeper accepts it (Notarized Developer ID)"
done

# ---------- 5. publish ----------
if [ "$STATE" = public ]; then
  ok "$TAG is already public: https://github.com/$REPO/releases/tag/$TAG"
elif [ "$MODE" = release ]; then
  say "Publish $TAG"
  gh api -X PATCH "repos/$REPO/releases/$RELEASE_ID" -F draft=false -f make_latest=true --jq '"  draft=\(.draft) url=\(.html_url)"' 
  t=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "https://github.com/$REPO/releases/download/$TAG/latest-mac.yml")" = 302 ]; do
    [ "$t" -lt 120 ] || die "$TAG was published, but its files are not public after 120 s"
    sleep 5; t=$((t + 5))
  done
  [ "$(curl -fsS "https://api.github.com/repos/$REPO/releases/latest" | node -p 'JSON.parse(require("fs").readFileSync(0)).tag_name')" = "$TAG" ] \
    || echo "  (the public API does not list $TAG as latest yet)"
  ok "PUBLISHED: https://github.com/$REPO/releases/tag/$TAG (public; publik takes it in at its next 10:00 UTC intake)"
else
  ok "all checks passed; the draft stays a draft ($MODE): https://github.com/$REPO/releases/tag/$TAG"
fi
say "Checks"
cat "$CHECKS"
echo "log: $LOG"
