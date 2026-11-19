#!/usr/bin/env bash
# live-proof-mac.sh — one macOS job of .github/workflows/live-update-proof.yml. CI only; never run it on
# your own Mac (it installs NitroAI in /Applications, writes TCC rows, starts the app and clicks in it).
#
# The release FROM_TAG is downloaded and installed as a user does it, the app is started the normal way
# (LaunchServices; no test hook, no feed override: a release build asks the LIVE feed
# https://publikhq.com/api/updates/nitroai/), and the job checks that the app ends on EXPECT:
#   - FROM_TAG = v$EXPECT: "no update"; the app stays on EXPECT and says so.
#   - FROM_TAG older:      the app downloads EXPECT itself, asks "Restart Now / Later", and VARIANT picks
#                          the answer. "later": the app keeps running; the user quits; the update installs.
# Every check writes one line to $OUT/assertions.txt (PASS / FAIL / NOTE). The first FAIL ends the job
# with exit 1. Screenshots, logs and TCC rows go to $OUT (uploaded by the workflow).
#
# Env: FROM_TAG, EXPECT, VARIANT (restart|later), ARCH (arm64|x64), REPO (owner/name), OUT,
#      NODE_PATH (holds blakejs, for the feed signature check).
set -euo pipefail

: "${FROM_TAG:?}" "${EXPECT:?}" "${VARIANT:?}" "${ARCH:?}" "${REPO:?}" "${OUT:?}"
NAME=NitroAI
BUNDLE_ID=com.nitroai.app
SLUG=nitroai
TEAM_ID=R5R3ZS54LV
FROM="${FROM_TAG#v}"
APP="/Applications/$NAME.app"
EXE="$APP/Contents/MacOS/$NAME"
DMG="NitroAI-mac-$ARCH.dmg"
ZIP="NitroAI-mac-$ARCH.zip"
FEED_URL="https://publikhq.com/api/updates/$SLUG/latest-mac.yml"
UPDATER_CACHE="$HOME/Library/Caches/$SLUG-updater"
SHIPIT="$HOME/Library/Caches/$BUNDLE_ID.ShipIt"
USER_TCC="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
SYSTEM_TCC="/Library/Application Support/com.apple.TCC/TCC.db"
# The publik sign-in gate starts with the app. It gets a key that is not a real key, so the gate does not
# create an install on publik for this runner (it shows "Sign in with publik" and waits). The updater does
# not read it. DO_NOT_TRACK keeps usage counts off. Nothing here signs in.
FAKE_KEY="pk_live_liveproof_ci_runner_not_a_key"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS/../.." && pwd)"
UPDATE=0
[ "$FROM" != "$EXPECT" ] && UPDATE=1

mkdir -p "$OUT"
RESULTS="$OUT/assertions.txt"
: > "$RESULTS"
DL="$(mktemp -d "${RUNNER_TEMP:-/tmp}/live-proof-dl.XXXXXX")"

step() { printf '\n==== %s\n' "$*"; }
shot_n=0
shot() { shot_n=$((shot_n + 1)); screencapture -x "$OUT/screen-$(printf %02d "$shot_n")-$1.png" 2>/dev/null || echo "(no screenshot: $1)"; }
pass() { echo "PASS  $*" | tee -a "$RESULTS"; }
note() { echo "NOTE  $*" | tee -a "$RESULTS"; }
fail() {
  echo "FAIL  $*" | tee -a "$RESULTS"
  echo "::error::$*"
  shot failure
  collect || true
  exit 1
}
plist_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || echo "(none)"; }
main_pid() { pgrep -x "$NAME" | head -1 || true; }
designated() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'; }
# Runs "$@" for at most $1 seconds (an AppleScript UI call can block while a modal dialog is open).
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$s" "$@"; }

# ---------- UI helpers (System Events; the runner's agent has the Accessibility grant) ----------

# Every window of a process with all it holds (sheets, groups): "WINDOW <name>", "TEXT <value>",
# "BUTTON <name>" lines. (A dialog's buttons can sit in a group, not in the window itself.)
ui_dump() {
  with_timeout 45 osascript - "$1" <<'AS' 2>&1 || true
on run argv
  set procName to item 1 of argv
  set out to ""
  tell application "System Events"
    if not (exists process procName) then return "NO-PROCESS"
    tell process procName
      repeat with w in windows
        try
          set out to out & "WINDOW " & (name of w as text) & linefeed
        on error
          set out to out & "WINDOW ?" & linefeed
        end try
        set els to {}
        try
          set els to entire contents of w
        end try
        repeat with e in els
          try
            set c to class of e
            if c is button then
              set out to out & "BUTTON " & (name of e as text) & linefeed
            else if c is static text then
              set v to value of e
              if v is missing value then set v to name of e
              set out to out & "TEXT " & (v as text) & linefeed
            end if
          end try
        end repeat
      end repeat
    end tell
  end tell
  return out
end run
AS
}

# Clicks the button named $2 anywhere in the windows of process $1. Prints CLICKED, NOT-FOUND or ERROR.
ui_click() {
  with_timeout 45 osascript - "$1" "$2" <<'AS' 2>&1 || true
on run argv
  set procName to item 1 of argv
  set btnName to item 2 of argv
  tell application "System Events"
    if not (exists process procName) then return "NO-PROCESS"
    tell process procName
      set theButton to missing value
      repeat with w in windows
        set els to {}
        try
          set els to entire contents of w
        end try
        repeat with e in els
          try
            if class of e is button and name of e is btnName then
              set theButton to contents of e
              exit repeat
            end if
          end try
        end repeat
        if theButton is not missing value then exit repeat
      end repeat
      if theButton is missing value then return "NOT-FOUND"
      try
        with timeout of 15 seconds
          click theButton
        end timeout
      on error errMsg number errNum
        -- No reply in time (-1712) or the app went away (-609): the click happened.
        if errNum is -1712 or errNum is -609 then return "CLICKED " & btnName & " (no reply " & errNum & ")"
        return "ERROR " & errNum & " " & errMsg
      end try
      return "CLICKED " & btnName
    end tell
  end tell
end run
AS
}

# Clicks the item of the app menu (the "NitroAI" menu) whose name starts with $1.
ui_app_menu() {
  with_timeout 45 osascript - "$NAME" "$1" <<'AS' 2>&1 || true
on run argv
  set procName to item 1 of argv
  set prefix to item 2 of argv
  tell application "System Events"
    if not (exists process procName) then return "NO-PROCESS"
    tell process procName
      set frontmost to true
      delay 1
      set appMenu to menu 1 of menu bar item procName of menu bar 1
      set hits to (menu items of appMenu whose name starts with prefix)
      if (count of hits) is 0 then return "NO-ITEM in: " & ((name of menu items of appMenu) as text)
      set itemName to name of item 1 of hits
      try
        with timeout of 15 seconds
          click item 1 of hits
        end timeout
      on error errMsg number errNum
        -- -1712: no reply in time, because the click opened a modal dialog: the click happened.
        if errNum is -1712 then return "CLICKED " & itemName & " (no reply: a dialog is open)"
        return "ERROR " & errNum & " " & errMsg
      end try
      return "CLICKED " & itemName
    end tell
  end tell
end run
AS
}

# Waits up to $2 seconds for a window or sheet of NitroAI with a button named $1. Prints the dump.
wait_dialog() {
  local button="$1" limit="$2" start=$SECONDS d
  while [ $((SECONDS - start)) -lt "$limit" ]; do # wall clock: a UI call can take long
    d="$(ui_dump "$NAME")"
    if printf '%s\n' "$d" | grep -qx "BUTTON $button"; then printf '%s\n' "$d"; return 0; fi
    sleep 3
  done
  return 1
}

# ---------- evidence ----------

collect() {
  step "Collect logs"
  mkdir -p "$OUT/caches"
  { ls -laR "$UPDATER_CACHE" 2>&1 || true; } > "$OUT/caches/updater-cache.txt"
  { ls -laR "$SHIPIT" 2>&1 | head -200 || true; } > "$OUT/caches/shipit.txt"
  for f in "$SHIPIT"/*.log "$SHIPIT"/ShipItState.plist "$UPDATER_CACHE"/pending/update-info.json; do
    [ -f "$f" ] && cp "$f" "$OUT/caches/" || true
  done
  [ -n "${DNS_PID:-}" ] && sudo kill "$DNS_PID" 2>/dev/null || true
  if [ -f "$OUT/dns.txt" ]; then
    grep -Eo '(A|AAAA)\? [A-Za-z0-9.-]+' "$OUT/dns.txt" | sort | uniq -c | sort -rn > "$OUT/dns-names.txt" || true
  fi
  ps -axo pid,lstart,command | grep -iE '[n]itroai|[s]hipit' > "$OUT/processes.txt" 2>&1 || true
}

# Starts the app the normal way: LaunchServices (`open`), as a double-click does. $1 names its log files.
# A quarantined app's first start shows Gatekeeper's question ("downloaded from the Internet… Open?") while
# the process already exists; the job answers Open like a user. Started = NitroAI has a window. Sets PID.
launch() {
  local name="$1" d start=$SECONDS answered=0 shot_taken=0
  local before; before="$(main_pid)"
  [ -n "$before" ] && fail "launch $name: NitroAI already runs (pid $before)"
  open -a "$APP" --stdout "$OUT/$name.out.log" --stderr "$OUT/$name.err.log" \
    --env DO_NOT_TRACK=1 --env "PUBLIK_API_KEY=$FAKE_KEY" &
  local open_pid=$!
  PID=""
  while [ $((SECONDS - start)) -lt 180 ]; do # wall clock: a UI call can take long
    d="$(ui_dump CoreServicesUIAgent)"
    if printf '%s\n' "$d" | grep -qx 'BUTTON Open'; then
      if [ "$answered" = 0 ]; then
        printf '%s\n' "$d" > "$OUT/gatekeeper-$name.txt"
        shot "gatekeeper-$name"
        note "start $name: Gatekeeper asked \"$(printf '%s\n' "$d" | sed -n 's/^TEXT //p' | head -1 | cut -c1-120)\"; answered Open ($(ui_click CoreServicesUIAgent Open))"
        answered=1
      else
        echo "Gatekeeper question still open; Open again: $(ui_click CoreServicesUIAgent Open)"
      fi
      sleep 2
      continue
    fi
    PID="$(main_pid)"
    if [ -n "$PID" ]; then
      case "$(ui_dump "$NAME")" in "WINDOW "*) break ;; esac
    fi
    PID=""
    if [ "$shot_taken" = 0 ] && [ $((SECONDS - start)) -ge 30 ]; then
      shot "launch-$name-waiting"; shot_taken=1
      printf '%s\n' "$d" > "$OUT/launch-$name-coreservicesuiagent.txt"
    fi
    sleep 2
  done
  # `open` only hands the start to LaunchServices; never wait for it without a limit.
  if kill -0 "$open_pid" 2>/dev/null; then sleep 5; kill "$open_pid" 2>/dev/null || true; fi
  wait "$open_pid" 2>/dev/null || true
  if [ -z "$PID" ]; then
    printf '%s\n' "$d" > "$OUT/launch-$name-coreservicesuiagent.txt"
    ps -axo pid,command | grep -E '[N]itroAI' > "$OUT/launch-$name-processes.txt" || true
    fail "launch $name: no NitroAI window in 180 s (screenshot, launch-$name-*.txt)"
  fi
  local cmd; cmd="$(ps -o command= -p "$PID")"
  case "$cmd" in
    "$EXE"*) ;;
    *AppTranslocation*) fail "launch $name: macOS runs NitroAI translocated ($cmd): it cannot update itself there; a Finder install is not translocated" ;;
    *) fail "launch $name: NitroAI runs from $cmd, not $EXE" ;;
  esac
  pass "launch $name: NitroAI started through LaunchServices and shows its window (pid $PID: $cmd)"
  echo "app quarantine after the start: $(xattr -p com.apple.quarantine "$APP" 2>/dev/null || echo none)" | tee -a "$OUT/quarantine.txt"
  sleep 5
}

# Quits the app the way a user does: NitroAI › Quit NitroAI. Waits for the process to end.
quit_app() {
  local pid; pid="$(main_pid)"
  [ -z "$pid" ] && return 0
  echo "quit: $(ui_app_menu "Quit")"
  local t=0
  while kill -0 "$pid" 2>/dev/null && [ "$t" -lt 60 ]; do sleep 2; t=$((t + 2)); done
  if kill -0 "$pid" 2>/dev/null; then
    shot quit-failed
    fail "NitroAI (pid $pid) did not quit from its menu in 60 s"
  fi
}

# The app's own answer to "Check for Updates…": clicks the menu item, reads the dialog, clicks OK.
menu_check() {
  local want="$1" d msg
  step "Check for Updates… (menu)"
  local click; click="$(ui_app_menu "Check for Updates")"
  echo "$click"
  case "$click" in CLICKED*) ;; *) fail "the menu item Check for Updates… could not be clicked: $click" ;; esac
  d="$(wait_dialog OK 120)" || { ui_dump "$NAME" > "$OUT/menu-check-ui.txt"; fail "no answer dialog in 120 s after Check for Updates…"; }
  printf '%s\n' "$d" > "$OUT/menu-check-dialog.txt"
  shot menu-check-answer
  msg="$(printf '%s\n' "$d" | sed -n 's/^TEXT //p' | tr '\n' ' ')"
  echo "dialog: $msg"
  case "$msg" in
    *"up to date"*"$NAME $want is the newest version."*) pass "Check for Updates… (clicked in the menu) answered: $msg" ;;
    *) fail "Check for Updates… answered \"$msg\", expected \"You’re up to date.\" with \"$NAME $want is the newest version.\"" ;;
  esac
  echo "$(ui_click "$NAME" OK)"
}

# ---------- 0. the runner ----------
step "Runner"
sw_vers | tee "$OUT/runner.txt"
uname -m | tee -a "$OUT/runner.txt"
csrutil status 2>&1 | tee -a "$OUT/runner.txt" || true
want_uname=arm64; [ "$ARCH" = x64 ] && want_uname=x86_64
[ "$(uname -m)" = "$want_uname" ] || fail "this runner is $(uname -m), the job is for $ARCH"
gk="$(spctl --status 2>&1 || true)"
echo "Gatekeeper: $gk"
if ! printf '%s' "$gk" | grep -q 'assessments enabled'; then
  sudo spctl --master-enable 2>&1 || sudo spctl --global-enable 2>&1 || true
  gk="$(spctl --status 2>&1 || true)"
fi
printf '%s' "$gk" | grep -q 'assessments enabled' || fail "Gatekeeper is not on: $gk"
pass "Gatekeeper on ($gk)"
pgrep -x "$NAME" >/dev/null && fail "NitroAI already runs on this runner"
[ -e "$APP" ] && fail "$APP already exists on this runner"
# The job answers dialogs with System Events (UI scripting). Check that it works here, now, with a limit.
ui_probe="$(with_timeout 30 osascript -e 'tell application "System Events" to return (count of menu bars of process "Finder") as text' 2>&1 || true)"
if [ "$ui_probe" != 1 ]; then
  for db in "$USER_TCC" "$SYSTEM_TCC"; do
    echo "== $db"
    sudo sqlite3 "$db" "SELECT service, client, client_type, auth_value, indirect_object_identifier FROM access WHERE service IN ('kTCCServiceAppleEvents','kTCCServiceAccessibility','kTCCServicePostEvent') ORDER BY service, client;" 2>&1 || true
  done > "$OUT/tcc-runner-grants.txt"
  fail "UI scripting (System Events) does not answer on this runner: ${ui_probe:-no answer in 30 s} (the runner's grants: tcc-runner-grants.txt)"
fi
pass "UI scripting works here (System Events reads the Finder's menu bar)"
launchctl getenv PUBLIK_UPDATES >/dev/null 2>&1 && launchctl unsetenv PUBLIK_UPDATES
# For a start that this job does not make (ShipIt starts the updated app after "Restart Now").
launchctl setenv DO_NOT_TRACK 1
launchctl setenv PUBLIK_API_KEY "$FAKE_KEY"

# ---------- 1. the live feed ----------
step "The live feed (what the app will read)"
LIVE="$OUT/live-feed/latest-mac.yml" # the signature's trusted comment names the file: keep its name
mkdir -p "$OUT/live-feed"
curl -fsS "$FEED_URL" -o "$LIVE" || fail "cannot read $FEED_URL"
curl -fsS "$FEED_URL.sig" -o "$LIVE.sig" || fail "cannot read $FEED_URL.sig"
cat "$LIVE"
node "$REPO_ROOT/scripts/publik-update-feed.cjs" verify "$LIVE" | tee -a "$OUT/live-feed/verify.txt" \
  || fail "the live feed's signature does not verify with the app's public key"
live_version="$(sed -n "s/^version: '\(.*\)'$/\1/p" "$LIVE")"
[ "$live_version" = "$EXPECT" ] || fail "publik serves $live_version, the run expects $EXPECT (start this run only when the feed serves $EXPECT)"
pass "publik's live feed serves $live_version, signed with the publik update key"
FEED_ZIP_SHA512="$(awk -v f="/$ZIP'" 'index($0, f) { getline; sub(/^ *sha512: /, ""); gsub(/'"'"'/, ""); print; exit }' "$LIVE")"
echo "feed sha512 of $ZIP: $FEED_ZIP_SHA512"

# ---------- 2. download as a user does ----------
step "Download $DMG of $FROM_TAG (the release asset publik's listing links)"
url="https://github.com/$REPO/releases/download/$FROM_TAG/$DMG"
curl -fsSL -o "$DL/$DMG" "$url" || fail "download failed: $url"
digest="$(gh api "repos/$REPO/releases/tags/$FROM_TAG" --jq ".assets[] | select(.name == \"$DMG\") | .digest" 2>/dev/null || true)"
have="sha256:$(shasum -a 256 "$DL/$DMG" | cut -d' ' -f1)"
echo "downloaded $(stat -f %z "$DL/$DMG") bytes, $have (release says $digest)"
[ -z "$digest" ] || [ "$digest" = "$have" ] || fail "the downloaded $DMG does not match the release asset digest"
# A browser marks a download with the quarantine attribute; Gatekeeper checks files that carry it.
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Google Chrome;$(uuidgen)" "$DL/$DMG"
echo "quarantine: $(xattr -p com.apple.quarantine "$DL/$DMG")"
dmg_assess="$(spctl -a -t open --context context:primary-signature -vv "$DL/$DMG" 2>&1 || true)"
echo "$dmg_assess" | tee "$OUT/spctl-dmg.txt"
if codesign -dv "$DL/$DMG" >/dev/null 2>&1; then
  printf '%s' "$dmg_assess" | grep -q ': accepted' && printf '%s' "$dmg_assess" | grep -q 'source=Notarized Developer ID' \
    || fail "Gatekeeper does not accept the quarantined $DMG as Notarized Developer ID: $(echo $dmg_assess)"
  pass "Gatekeeper accepts the quarantined $DMG: $(printf '%s' "$dmg_assess" | grep -E 'accepted|source=|origin=' | tr '\n' ' ')"
else
  # Releases before release.yml signed the dmg (v0.2.7 and older): the dmg is notarized but has no code
  # signature of its own. Gatekeeper then judges the app inside, at its first start (checked below).
  note "$DMG of $FROM_TAG has no code signature of its own (spctl on the dmg: $(printf '%s' "$dmg_assess" | tr '\n' ' ')); Gatekeeper checks the app inside: asserted below with the quarantine, and at the first start"
fi
xcrun stapler validate "$DL/$DMG" > "$OUT/stapler-dmg.txt" 2>&1 || fail "$DMG has no valid stapled ticket: $(cat "$OUT/stapler-dmg.txt")"
pass "$DMG carries a stapled notarization ticket"

# ---------- 3. install as a user does ----------
step "Install: open the dmg, drag NitroAI onto Applications"
MNT="$DL/mnt"
mkdir -p "$MNT"
hdiutil attach -readonly -noautoopen -mountpoint "$MNT" "$DL/$DMG" > "$OUT/hdiutil.txt"
ls -la "$MNT" | tee -a "$OUT/hdiutil.txt"
swiftc -O "$SCRIPTS/live-proof-mac-tool.swift" -o "$DL/mac-tool" > "$OUT/mac-tool-build.txt" 2>&1 \
  || fail "cannot build .github/scripts/live-proof-mac-tool.swift (mac-tool-build.txt)"
# The dmg's window in the Finder (as a double-click on the dmg shows it), then a mouse drag of the NitroAI
# icon onto the Applications icon. Only a user's drag in the Finder marks the copy "moved by the user";
# a copy made another way (cp, ditto, a Finder script) keeps quarantine flag 0x0080 and macOS runs that
# app translocated, from a read-only random path where it cannot update itself.
open "$MNT"
sleep 3
drag="$(with_timeout 120 "$DL/mac-tool" drag "$NAME" Applications 2>&1 || true)"
echo "$drag"
shot dmg-drag
start=$SECONDS
until [ -f "$APP/Contents/Info.plist" ] && codesign --verify --deep --strict "$APP" 2>/dev/null; do
  [ $((SECONDS - start)) -lt 180 ] || fail "the drag did not copy $NAME.app to /Applications in 180 s: $(echo $drag)"
  sleep 3
done
sleep 5 # the Finder sets the copy's attributes last
pass "dragged NitroAI from the dmg window onto Applications in the Finder: $(printf '%s' "$drag" | grep '^drag ' || true)"
with_timeout 30 osascript -e 'tell application "Finder" to close every window' >/dev/null 2>&1 || true
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet || true
q="$(xattr -p com.apple.quarantine "$APP" 2>/dev/null || true)"
[ -n "$q" ] || fail "the copied app has no quarantine (the dmg has: $(xattr -p com.apple.quarantine "$DL/$DMG" 2>/dev/null))"
echo "app quarantine after the drag: $q" | tee "$OUT/quarantine.txt"
transl="$("$DL/mac-tool" translocates "$APP" 2>&1 || true)"
[ "$transl" = false ] || fail "macOS would run the dragged app translocated (SecTranslocateURLShouldRunTranslocated: $transl; quarantine $q)"
pass "the app keeps its quarantine ($q) and macOS will run it in place, not translocated (SecTranslocateURLShouldRunTranslocated = false)"
v="$(plist_version "$APP")"
[ "$v" = "$FROM" ] || fail "the installed app is $v, not $FROM"
pass "installed $APP, version $v ($(lipo -archs "$EXE"))"
app_assess="$(spctl -a -t exec -vv "$APP" 2>&1 || true)"
echo "$app_assess" | tee "$OUT/spctl-app-before.txt"
printf '%s' "$app_assess" | grep -q ': accepted' && printf '%s' "$app_assess" | grep -q 'source=Notarized Developer ID' \
  || fail "Gatekeeper does not accept the installed app: $(echo $app_assess)"
pass "Gatekeeper accepts the installed, quarantined app: $(printf '%s' "$app_assess" | grep -E 'source=|origin=' | tr '\n' ' ')"
codesign --verify --deep --strict "$APP" 2> "$OUT/codesign-before.txt" || fail "codesign --verify fails on the installed app"
codesign -dvv "$APP" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|Runtime)' | tee -a "$OUT/codesign-before.txt"

# ---------- 4. permissions: the designated requirement and four TCC grants ----------
step "Designated requirement and TCC grants"
DR_BEFORE="$(designated "$APP")"
echo "designated => $DR_BEFORE" | tee "$OUT/designated-before.txt"
case "$DR_BEFORE" in *"identifier \"$BUNDLE_ID\""*"$TEAM_ID"*) ;; *) fail "unexpected designated requirement: $DR_BEFORE" ;; esac
printf '%s' "$DR_BEFORE" | csreq -r- -b "$OUT/csreq-before.bin"
CSREQ_HEX="$(xxd -p "$OUT/csreq-before.bin" | tr -d '\n' | tr 'a-f' 'A-F')" # as SQLite's hex() prints it
echo "csreq blob: $(stat -f %z "$OUT/csreq-before.bin") bytes"

# tcc user|system sqlite3-args...: the user database as the runner user (sudo if that is refused), the
# system database with sudo.
tcc() {
  local kind="$1"; shift
  if [ "$kind" = system ]; then sudo sqlite3 "$@"; else sqlite3 "$@" 2>/dev/null || sudo sqlite3 "$@"; fi
}
tcc_db() { if [ "$1" = system ]; then echo "$SYSTEM_TCC"; else echo "$USER_TCC"; fi; }
# One grant row, built from the columns this macOS has (PRAGMA table_info): allowed (auth_value 2), for
# the bundle ID (client_type 0), with the csreq made from the app's designated requirement.
tcc_grant() {
  local kind="$1" service="$2" reason="$3" db cols="" vals="" c v
  db="$(tcc_db "$kind")"
  for c in $(tcc "$kind" "$db" "SELECT name FROM pragma_table_info('access');"); do
    case "$c" in
      service) v="'$service'" ;;
      client) v="'$BUNDLE_ID'" ;;
      client_type) v=0 ;;
      auth_value) v=2 ;;
      auth_reason) v="$reason" ;;
      auth_version) v=1 ;;
      csreq) v="X'$CSREQ_HEX'" ;;
      policy_id | indirect_object_code_identity | pid | pid_version) v=NULL ;;
      indirect_object_identifier_type) v=0 ;;
      indirect_object_identifier | boot_uuid) v="'UNUSED'" ;;
      flags | last_reminded) v=0 ;;
      last_modified) v="CAST(strftime('%s','now') AS INTEGER)" ;;
      allowed | prompt_count) v=1 ;; # the schema before macOS 11
      *) continue ;;                 # the column's default
    esac
    cols="$cols${cols:+,}$c"
    vals="$vals${vals:+,}$v"
  done
  tcc "$kind" "$db" "INSERT OR REPLACE INTO access ($cols) VALUES ($vals);"
}
tcc_rows() { # kind → "service|auth_value|auth_reason|csreq hex" lines
  tcc "$1" "$(tcc_db "$1")" "SELECT service, auth_value, auth_reason, hex(csreq) FROM access WHERE client='$BUNDLE_ID' AND client_type=0 ORDER BY service;"
}

for kind in user system; do
  tcc "$kind" "$(tcc_db "$kind")" ".schema access" > "$OUT/tcc-schema-$kind.sql" || fail "cannot read the $kind TCC database"
done
cat "$OUT/tcc-schema-system.sql"
# Camera and microphone live in the user's database, screen capture and accessibility in the system's
# (where tccd looks them up). auth_reason 2 = the user allowed it in a prompt, 3 = in System Settings.
GRANTS="user:kTCCServiceCamera:2 user:kTCCServiceMicrophone:2 system:kTCCServiceScreenCapture:3 system:kTCCServiceAccessibility:3"
for g in $GRANTS; do
  IFS=: read -r kind service reason <<< "$g"
  tcc_grant "$kind" "$service" "$reason" || fail "cannot write the $service grant into the $kind TCC database"
done
for kind in user system; do tcc_rows "$kind"; done | tee "$OUT/tcc-before.txt"
for g in $GRANTS; do
  IFS=: read -r kind service reason <<< "$g"
  row="$(tcc_rows "$kind" | grep "^$service|" || true)"
  [ "$row" = "$service|2|$reason|$CSREQ_HEX" ] || fail "the $service row is not as written: $row"
done
pass "4 TCC grants written for $BUNDLE_ID with the csreq of its designated requirement (camera, microphone: user TCC.db; screen capture, accessibility: system TCC.db)"

# ---------- 5. start the app; the updater talks to the live feed ----------
step "Start NitroAI (the normal way) and wait for the updater"
iface="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
if [ -n "$iface" ]; then
  sudo tcpdump -i "$iface" -n -l 'udp port 53' > "$OUT/dns.txt" 2>"$OUT/dns-tcpdump.err" &
  DNS_PID=$!
fi
launch run1
shot started
PID1="$PID"
RUN1_START="$(date +%s)"

if [ "$UPDATE" = 0 ]; then
  t=0
  while [ "$t" -lt 300 ]; do
    grep -q 'is not available' "$OUT/run1.out.log" 2>/dev/null && break
    grep -qi 'error' "$OUT/run1.err.log" 2>/dev/null && break
    sleep 3; t=$((t + 3))
  done
  echo "--- app log (updater lines)"; grep -h '\[updates\]' "$OUT/run1.out.log" "$OUT/run1.err.log" || true
  grep -q "latest-mac.yml $EXPECT: signature OK" "$OUT/run1.out.log" \
    || fail "the app did not log a verified feed $EXPECT (see run1.*.log)"
  pass "the app read the live feed and verified its signature: $(grep -h 'signature OK' "$OUT/run1.out.log" | head -1)"
  line="$(grep -h 'is not available' "$OUT/run1.out.log" | head -1 || true)"
  [ -n "$line" ] || fail "the app did not report \"no update\" in 300 s (see run1.*.log)"
  case "$line" in *"version $EXPECT is not available"*) ;; *) fail "unexpected: $line" ;; esac
  pass "the running app reports its version: $line"
  sleep 20
  d="$(ui_dump "$NAME")"
  printf '%s\n' "$d" > "$OUT/ui-after-check.txt"
  printf '%s\n' "$d" | grep -q 'BUTTON Restart Now' && fail "an update question showed although $EXPECT is the newest"
  ls "$UPDATER_CACHE/pending" 2>/dev/null | grep -qi '\.zip$' && fail "the updater downloaded a file although there is no update"
  pass "no update question, no download (pending: $(ls "$UPDATER_CACHE/pending" 2>/dev/null | tr '\n' ' '))"
  [ "$(plist_version "$APP")" = "$EXPECT" ] || fail "the app on disk is $(plist_version "$APP"), not $EXPECT"
  kill -0 "$PID1" 2>/dev/null || fail "the app stopped (pid $PID1)"
  pass "the app stays on $EXPECT and keeps running (pid $PID1)"
else
  d="$(wait_dialog 'Restart Now' 600)" || {
    echo "--- app log"; cat "$OUT/run1.out.log" "$OUT/run1.err.log" 2>/dev/null | tail -60
    ui_dump "$NAME" > "$OUT/ui-no-question.txt"
    fail "no \"Restart Now\" question within 600 s"
  }
  printf '%s\n' "$d" > "$OUT/update-question.txt"
  shot update-question
  echo "--- app log (updater lines)"; grep -h '\[updates\]' "$OUT/run1.out.log" "$OUT/run1.err.log" || true
  question="$(printf '%s\n' "$d" | sed -n 's/^TEXT //p' | tr '\n' ' ')"
  case "$question" in *"$NAME $EXPECT is ready to install."*) ;; *) fail "unexpected question: $question" ;; esac
  pass "the app downloaded $EXPECT by itself and asks: $question"
  grep -q "latest-mac.yml $EXPECT: signature OK" "$OUT/run1.out.log" || fail "the app did not log a verified feed $EXPECT"
  pass "feed verified by the app: $(grep -h 'signature OK' "$OUT/run1.out.log" | head -1)"
  found="$(grep -h 'Found version' "$OUT/run1.out.log" | head -1 || true)"
  [ -n "$found" ] && pass "the app's log names the file: $found"
  pending="$UPDATER_CACHE/pending/$ZIP"
  [ -f "$pending" ] || fail "no $pending: where did the update come from?"
  got="$(openssl dgst -sha512 -binary "$pending" | base64)"
  [ "$got" = "$FEED_ZIP_SHA512" ] || fail "the downloaded $ZIP does not have the feed's sha512"
  pass "the only update file is the updater's own download $pending, sha512 = the signed feed's"
  [ "$(plist_version "$APP")" = "$FROM" ] || fail "the bundle changed before the answer"

  if [ "$VARIANT" = restart ]; then
    step "Answer Restart Now"
    clicked="$(ui_click "$NAME" 'Restart Now')"
    echo "$clicked"
    CLICK_T="$(date +%s)"
    driven=1
    case "$clicked" in
      CLICKED*) pass "answered the question: $clicked" ;;
      *) driven=0; note "the question could not be clicked on this runner ($clicked): quit and reopen instead" ;;
    esac
    if [ "$driven" = 1 ]; then
      t=0
      while kill -0 "$PID1" 2>/dev/null && [ "$t" -lt 120 ]; do sleep 2; t=$((t + 2)); done
      kill -0 "$PID1" 2>/dev/null && fail "the app did not quit after Restart Now"
      pass "the old app (pid $PID1) quit after Restart Now"
      t=0
      PID=""
      while [ "$t" -lt 300 ]; do
        PID="$(main_pid)"
        [ -n "$PID" ] && [ "$(plist_version "$APP")" = "$EXPECT" ] && break
        sleep 3; t=$((t + 3))
      done
      [ "$(plist_version "$APP")" = "$EXPECT" ] || fail "after Restart Now the bundle is $(plist_version "$APP"), not $EXPECT"
      [ -n "$PID" ] || fail "the app did not start again after Restart Now (300 s)"
      pass "the app started again by itself (pid $PID, $(ps -o lstart= -p "$PID"))"
    else
      quit_app
      t=0
      while [ "$(plist_version "$APP")" != "$EXPECT" ] && [ "$t" -lt 300 ]; do sleep 3; t=$((t + 3)); done
      launch run2
    fi
  else
    step "Answer Later"
    clicked="$(ui_click "$NAME" 'Later')"
    echo "$clicked"
    case "$clicked" in CLICKED*) pass "answered the question: $clicked" ;; *) fail "the Later button could not be clicked: $clicked" ;; esac
    sleep 30
    kill -0 "$PID1" 2>/dev/null || fail "the app stopped after Later"
    [ "$(plist_version "$APP")" = "$FROM" ] || fail "the bundle changed while the app runs after Later"
    pass "after Later the app keeps running as $FROM (pid $PID1); nothing is installed yet"
    shot after-later
    step "Quit (NitroAI › Quit NitroAI): the update installs now"
    quit_app
    pass "the app quit from its menu"
    t=0
    while [ "$(plist_version "$APP")" != "$EXPECT" ] && [ "$t" -lt 300 ]; do sleep 3; t=$((t + 3)); done
    [ "$(plist_version "$APP")" = "$EXPECT" ] || fail "300 s after the quit the bundle is $(plist_version "$APP"), not $EXPECT"
    pass "the update installed at quit: the bundle is $EXPECT"
    launch run2
  fi
fi

# ---------- 6. the app after: version, menu item ----------
step "The app now"
PID_NOW="$(main_pid)"
[ -n "$PID_NOW" ] || fail "NitroAI does not run"
v="$(plist_version "$APP")"
[ "$v" = "$EXPECT" ] || fail "Info.plist says $v, not $EXPECT"
pass "Info.plist: CFBundleShortVersionString $v"
exe_of_pid="$(ps -o command= -p "$PID_NOW")"
case "$exe_of_pid" in "$EXE"*) ;; *) fail "the running NitroAI is not $EXE: $exe_of_pid" ;; esac
if [ "$UPDATE" = 1 ]; then
  [ "$PID_NOW" != "$PID1" ] || fail "the running process is still the one of $FROM"
fi
pass "running: pid $PID_NOW, started $(ps -o lstart= -p "$PID_NOW"), $exe_of_pid"
if [ -f "$OUT/run2.out.log" ]; then
  t=0
  while ! grep -q 'is not available' "$OUT/run2.out.log" 2>/dev/null && [ "$t" -lt 180 ]; do sleep 3; t=$((t + 3)); done
  line="$(grep -h 'is not available' "$OUT/run2.out.log" | head -1 || true)"
  case "$line" in *"version $EXPECT is not available"*) pass "the running app's log: $line" ;; *) fail "run2: no \"$EXPECT is not available\" line (see run2.*.log)" ;; esac
else
  sleep 20 # the background check of the new start
fi
menu_check "$EXPECT"

# ---------- 7. permissions after ----------
step "Permissions after"
DR_AFTER="$(designated "$APP")"
echo "designated => $DR_AFTER" | tee "$OUT/designated-after.txt"
[ "$DR_AFTER" = "$DR_BEFORE" ] || fail "the designated requirement changed: $DR_AFTER"
pass "designated requirement unchanged: $DR_AFTER"
app_assess="$(spctl -a -t exec -vv "$APP" 2>&1 || true)"
echo "$app_assess" | tee "$OUT/spctl-app-after.txt"
printf '%s' "$app_assess" | grep -q ': accepted' && printf '%s' "$app_assess" | grep -q 'source=Notarized Developer ID' \
  || fail "Gatekeeper does not accept the app after: $(echo $app_assess)"
pass "Gatekeeper accepts the app on $EXPECT: $(printf '%s' "$app_assess" | grep -E 'source=' | tr '\n' ' ')"
codesign --verify --deep --strict "$APP" 2> "$OUT/codesign-after.txt" || fail "codesign --verify fails after"
codesign -dvv "$APP" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|Runtime)' | tee -a "$OUT/codesign-after.txt"
for kind in user system; do tcc_rows "$kind"; done | tee "$OUT/tcc-after.txt"
n=0
for g in $GRANTS; do
  IFS=: read -r kind service reason <<< "$g"
  row="$(tcc_rows "$kind" | grep "^$service|" || true)"
  [ -n "$row" ] || fail "the $service row is gone"
  hex="${row##*|}"
  [ "$(printf '%s' "$row" | cut -d'|' -f2)" = 2 ] || fail "the $service row is no longer allowed: $row"
  printf '%s' "$hex" | xxd -r -p > "$OUT/csreq-$service.bin"
  text="$(csreq -r "$OUT/csreq-$service.bin" -t 2>&1)"
  codesign --verify -R "$OUT/csreq-$service.bin" "$APP" 2>> "$OUT/csreq-verify.txt" \
    || fail "$EXPECT does not satisfy the stored csreq of $service ($text)"
  codesign --verify -R="$text" "$APP" 2>> "$OUT/csreq-verify.txt" \
    || fail "$EXPECT does not satisfy the stored requirement text of $service ($text)"
  echo "$service: stored csreq \"$text\" — satisfied by the app on disk" | tee -a "$OUT/csreq-verify.txt"
  n=$((n + 1))
done
[ "$n" = 4 ] || fail "checked $n grants, not 4"
pass "all 4 TCC rows are still there, and the app ($EXPECT) satisfies the stored csreq of each (the check tccd makes). The runner cannot show a consent prompt; this is the proof that the update needs no new one"

# ---------- 8. nothing downloaded by hand ----------
step "No manual download"
others="$(find "$HOME/Downloads" "$HOME/Desktop" /tmp /private/tmp -maxdepth 3 -iname '*nitroai*' 2>/dev/null | grep -v '^/private/tmp/live-proof' || true)"
echo "files named NitroAI outside the updater cache: ${others:-none}"
[ -z "$others" ] || fail "unexpected NitroAI files: $others"
echo "this job downloaded only: $(ls "$DL")"
pass "the only installer this job downloaded is $DMG of $FROM_TAG; any update file came from the app's updater ($UPDATER_CACHE)"

quit_app
collect
grep -E 'publikhq|github|githubusercontent' "$OUT/dns-names.txt" 2>/dev/null | sed 's/^/DNS lookups: /' | tee -a "$RESULTS" || true
echo
echo "==== assertions"
cat "$RESULTS"
