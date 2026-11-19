# live-proof-win.ps1 — the Windows job of .github/workflows/live-update-proof.yml. CI only.
#
# Downloads the Windows installer of FROM_TAG from the GitHub release, installs it silently (as the
# installer does for a user, per-user), starts the installed NitroAI.exe (no test hook, no feed override:
# a release build asks the LIVE feed https://publikhq.com/api/updates/nitroai/latest.yml) and checks that
# the app ends on EXPECT:
#   - FROM_TAG = v$EXPECT: "no update"; the app stays on EXPECT and says so in its log.
#   - FROM_TAG older:      the app downloads EXPECT itself and asks "Restart Now / Later" (UI Automation
#                          answers it). "later": the app keeps running; the user closes it; the update
#                          installs at quit.
# Each check writes one line to $OUT/assertions.txt (PASS / FAIL / NOTE). The first FAIL ends the job.
#
# Env: FROM_TAG, EXPECT, VARIANT (restart|later), REPO, OUT, NODE_PATH (holds blakejs), GH_TOKEN.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3

$FromTag = $env:FROM_TAG; $Expect = $env:EXPECT; $Variant = $env:VARIANT; $Repo = $env:REPO; $Out = $env:OUT
foreach ($v in 'FROM_TAG', 'EXPECT', 'VARIANT', 'REPO', 'OUT') { if (-not [Environment]::GetEnvironmentVariable($v)) { throw "$v is not set" } }
$Name = 'NitroAI'
$Slug = 'nitroai'
$From = $FromTag -replace '^v', ''
$Update = $From -ne $Expect
$Installer = 'NitroAI-Setup-Windows.exe'
$FeedUrl = "https://publikhq.com/api/updates/$Slug/latest.yml"
$UpdaterCache = Join-Path $env:LOCALAPPDATA "$Slug-updater"
# The publik sign-in gate starts with the app. It gets a key that is not a real key, so the gate does not
# create an install on publik for this runner. The updater does not read it. Nothing here signs in.
$FakeKey = 'pk_live_liveproof_ci_runner_not_a_key'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Results = Join-Path $Out 'assertions.txt'
Set-Content -Path $Results -Value $null
$Dl = Join-Path $env:RUNNER_TEMP 'live-proof-dl'
New-Item -ItemType Directory -Force -Path $Dl | Out-Null

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LiveProofKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(150); mouse_event(2, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
}
// Electron's message boxes on Windows are task dialogs (#32770). UI Automation shows their texts under the
// app window but not always their buttons; the buttons are plain Win32 "Button" windows, found here.
public static class LiveProofWin32 {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint ms, out IntPtr r);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint ms, out IntPtr r);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, s.Capacity); return s.ToString(); }
  // WM_GETTEXT (GetWindowText cannot read a control of another process).
  static string Txt(IntPtr h) { var s = new StringBuilder(1024); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)s.Capacity, s, 2, 2000, out r); return s.ToString(); }
  static bool WaitGone(IntPtr d) { for (int i = 0; i < 20 && IsWindow(d); i++) System.Threading.Thread.Sleep(100); return !IsWindow(d); }
  // "DIALOG<tab>hwnd<tab>title" for each visible #32770 window of the processes, each followed by
  // "BUTTON<tab>hwnd<tab>text" for its visible buttons.
  public static string[] Dialogs(int[] pids) {
    var set = new HashSet<int>(pids);
    var dialogs = new List<IntPtr>();
    var lines = new List<string>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (set.Contains((int)pid) && IsWindowVisible(h) && Cls(h) == "#32770") dialogs.Add(h); return true; }, IntPtr.Zero);
    foreach (var d in dialogs) {
      lines.Add("DIALOG\t" + d.ToInt64() + "\t" + Txt(d));
      EnumChildWindows(d, (h, l) => { if (Cls(h) == "Button" && IsWindowVisible(h)) lines.Add("BUTTON\t" + h.ToInt64() + "\t" + Txt(h).Replace("&", "")); return true; }, IntPtr.Zero);
    }
    return lines.ToArray();
  }
  // A mouse click on the button's middle, as a user does. If the dialog stays open: BM_CLICK, then
  // TDM_CLICK_BUTTON with the button's id. Returns the way that closed the dialog, or "still open".
  public static string Click(long button, long dialog) {
    IntPtr b = new IntPtr(button), d = new IntPtr(dialog), r;
    SetForegroundWindow(d); System.Threading.Thread.Sleep(300);
    RECT rc;
    if (GetWindowRect(b, out rc)) { LiveProofKeys.Click((rc.L + rc.R) / 2, (rc.T + rc.B) / 2); if (WaitGone(d)) return "mouse click"; }
    SendMessageTimeout(b, 0x00F5, IntPtr.Zero, IntPtr.Zero, 2, 5000, out r);
    if (WaitGone(d)) return "BM_CLICK";
    SendMessageTimeout(d, 0x0466, (IntPtr)GetDlgCtrlID(b), IntPtr.Zero, 2, 5000, out r);
    return WaitGone(d) ? "TDM_CLICK_BUTTON" : "still open";
  }
  public static void Close(long dialog) { PostMessage(new IntPtr(dialog), 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]

function Step($t) { Write-Host "`n==== $t" }
$script:shotN = 0
function Shot($label) {
  $script:shotN++
  try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Out ('screen-{0:D2}-{1}.png' -f $script:shotN, $label)))
    $g.Dispose(); $bmp.Dispose()
  } catch { Write-Host "(no screenshot ${label}: $_)" }
}
function Pass($t) { "PASS  $t" | Tee-Object -FilePath $Results -Append | Write-Host }
function Note($t) { "NOTE  $t" | Tee-Object -FilePath $Results -Append | Write-Host }
function Fail($t) {
  "FAIL  $t" | Tee-Object -FilePath $Results -Append | Write-Host
  Write-Host "::error::$t"
  Shot 'failure'
  try { Collect } catch { Write-Host "collect: $_" }
  exit 1
}

function Norm($v) { if ($v) { ($v -replace '\.0$', '').Trim() } else { '(none)' } } # 0.2.7.0 -> 0.2.7
function ExeVersion($p) { if (Test-Path $p) { Norm (Get-Item $p).VersionInfo.ProductVersion } else { '(missing)' } }
function Sha512B64($p) {
  $s = [System.IO.File]::OpenRead($p)
  try { [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash($s)) } finally { $s.Dispose() }
}
# The main NitroAI process (Electron's helpers carry --type=...).
function MainProcess {
  $m = Get-CimInstance Win32_Process -Filter "Name = '$Name.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
  if ($m) { Get-Process -Id $m.ProcessId -ErrorAction SilentlyContinue } else { $null }
}

# ---------- UI Automation ----------
function AppWindows {
  $ids = @(Get-Process -Name $Name -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($ids.Count -eq 0) { return @() }
  $all = $AE::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)
  @($all | Where-Object { $ids -contains $_.Current.ProcessId })
}
# "WINDOW <title> [class]", "TEXT <name>", "BUTTON <name>" lines for every window of the app.
function Dump {
  $lines = @()
  foreach ($w in AppWindows) {
    $lines += "WINDOW $($w.Current.Name) [$($w.Current.ClassName)]"
    foreach ($e in $w.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      $ct = $e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if (($ct -eq 'Text' -or $ct -eq 'Button') -and $e.Current.Name) { $lines += "$($ct.ToUpper()) $($e.Current.Name)" }
    }
  }
  foreach ($l in (Win32Dialogs)) {
    $f = $l -split "`t", 3
    if ($f[0] -eq 'DIALOG') { $lines += "WINDOW $($f[2]) [#32770]" } else { $lines += "BUTTON $($f[2])" }
  }
  , $lines
}
# The app's open message boxes, from Win32 (see LiveProofWin32).
function Win32Dialogs {
  $ids = @(Get-Process -Name $Name -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($ids.Count -eq 0) { return @() }
  @([LiveProofWin32]::Dialogs([int[]]$ids))
}
function ClickButton($label) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($w in AppWindows) {
    foreach ($b in $w.FindAll($Scope::Descendants, $cond)) {
      if ($b.Current.Name -like "$label*") {
        $p = $null
        if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return "CLICKED '$($b.Current.Name)' in '$($w.Current.Name)'" }
        $b.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait(' ')
        return "PRESSED '$($b.Current.Name)' in '$($w.Current.Name)'"
      }
    }
  }
  $dlg = $null
  foreach ($l in (Win32Dialogs)) {
    $f = $l -split "`t", 3
    if ($f[0] -eq 'DIALOG') { $dlg = $f; continue }
    if ($dlg -and $f[2] -like "$label*") {
      $how = [LiveProofWin32]::Click([long]$f[1], [long]$dlg[1])
      if ($how -eq 'still open') { Write-Host "'$($f[2])' in '$($dlg[2])' was clicked, but the dialog is still open"; return 'NOT-FOUND' }
      return "CLICKED '$($f[2])' in '$($dlg[2])' (Win32 $how)"
    }
  }
  'NOT-FOUND'
}
function WaitDialog($button, $seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $d = Dump
    if ($d | Where-Object { $_ -like "BUTTON $button*" }) { return , $d }
    Start-Sleep 3
  }
  $null
}
function TextsOf($dump) { (($dump | Where-Object { $_ -like 'TEXT *' }) -replace '^TEXT ', '') -join ' ' }

# ---------- evidence ----------
function Collect {
  Step 'Collect logs'
  $c = Join-Path $Out 'caches'
  New-Item -ItemType Directory -Force -Path $c | Out-Null
  if (Test-Path $UpdaterCache) {
    Get-ChildItem -Recurse -Force $UpdaterCache | Format-Table FullName, Length, LastWriteTime -AutoSize | Out-String -Width 300 | Set-Content (Join-Path $c 'updater-cache.txt')
    $ui = Join-Path $UpdaterCache 'pending\update-info.json'
    if (Test-Path $ui) { Copy-Item $ui $c }
  }
  Get-CimInstance Win32_Process -Filter "Name = '$Name.exe'" | Select-Object ProcessId, CreationDate, ExecutablePath, CommandLine | Format-List | Out-String -Width 400 | Set-Content (Join-Path $Out 'processes.txt')
  Get-DnsClientCache -ErrorAction SilentlyContinue | Where-Object { $_.Entry -match 'publikhq|github' } | Select-Object Entry, Data | Sort-Object Entry -Unique | Format-Table -AutoSize | Out-String -Width 300 | Set-Content (Join-Path $Out 'dns-cache.txt')
}

function Launch($label) {
  if (MainProcess) { Fail "launch ${label}: NitroAI already runs" }
  $env:DO_NOT_TRACK = '1'
  $env:PUBLIK_API_KEY = $FakeKey
  Remove-Item Env:PUBLIK_UPDATES -ErrorAction SilentlyContinue
  # The installed NitroAI.exe, as its Start menu shortcut starts it, with its output kept for the log.
  $p = Start-Process -FilePath $script:Exe -PassThru `
    -RedirectStandardOutput (Join-Path $Out "$label.out.log") -RedirectStandardError (Join-Path $Out "$label.err.log")
  Start-Sleep 8
  if ($p.HasExited) { Fail "launch ${label}: NitroAI exited at once (code $($p.ExitCode))" }
  Pass "launch ${label}: started $script:Exe (pid $($p.Id), version $(Norm $p.MainModule.FileVersionInfo.ProductVersion))"
  $p
}
function LogText($label) { ((Get-Content (Join-Path $Out "$label.out.log"), (Join-Path $Out "$label.err.log") -Raw -ErrorAction SilentlyContinue) -join "`n") }
function WaitLog($label, $pattern, $seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $t = LogText $label
    if ($t -match $pattern) { return $true }
    Start-Sleep 3
  }
  $false
}

# Closes NitroAI the way a user does: the window's close button (UI Automation WindowPattern.Close).
function CloseApp {
  $p = MainProcess
  if (-not $p) { return }
  # A message box that is still open blocks the window's close: answer it first (OK, else its close box).
  $open = @(Win32Dialogs | Where-Object { $_ -like "DIALOG`t*" } | ForEach-Object { ($_ -split "`t", 3)[2] })
  if ($open.Count) {
    Note "a message box was still open before the close ($($open -join ', ')): answered OK, else closed"
    Write-Host (ClickButton 'OK')
    foreach ($l in @(Win32Dialogs | Where-Object { $_ -like "DIALOG`t*" })) { [LiveProofWin32]::Close([long](($l -split "`t", 3)[1])) }
    Start-Sleep 2
  }
  foreach ($w in AppWindows) {
    $wp = $null
    if ($w.Current.ClassName -like 'Chrome_WidgetWin*' -and $w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
      Write-Host "closing window '$($w.Current.Name)'"
      $wp.Close()
    }
  }
  if (-not $p.WaitForExit(60000)) { Shot 'close-failed'; Fail "NitroAI (pid $($p.Id)) did not end 60 s after its window was closed" }
}

# Best effort: Help › Check for Updates… in the window's (hidden) menu bar. Alt shows it. Never throws:
# returns 'CLICKED' or why not.
function TryMenuCheck { try { TryMenuCheckInner } catch { "error: $($_.Exception.Message)" } }
# Opens or clicks a UI Automation element: Invoke if it has it, else a mouse click on its middle.
function Activate($e) {
  $p = $null
  try { if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' } } catch {}
  $r = $e.Current.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { return 'no position' }
  [LiveProofKeys]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  "mouse click at $([int]($r.X + $r.Width / 2)),$([int]($r.Y + $r.Height / 2))"
}
function TryMenuCheckInner {
  $gate = AppWindows | Where-Object { $_.Current.ClassName -like 'Chrome_WidgetWin*' } | Select-Object -First 1
  if (-not $gate) { return 'no window' }
  try { $gate.SetFocus() } catch {}
  Start-Sleep 1
  [LiveProofKeys]::Tap(0x12) # Alt alone: Electron shows the auto-hidden menu bar
  Start-Sleep 1
  $help = $null
  foreach ($w in AppWindows) {
    $help = $w.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -match '^&?Help$' } | Select-Object -First 1
    if ($help) { break }
  }
  if (-not $help) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); return 'no Help item in the UI Automation tree' }
  Write-Host "Help: $($help.Current.ControlType.ProgrammaticName), opened by $(Activate $help)"
  Start-Sleep 2
  $item = $null
  foreach ($w in AppWindows) {
    $item = $w.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like 'Check for Updates*' } | Select-Object -First 1
    if ($item) { break }
  }
  if (-not $item) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}{ESC}'); return 'no Check for Updates item' }
  Write-Host "Check for Updates…: $($item.Current.ControlType.ProgrammaticName), clicked by $(Activate $item)"
  'CLICKED'
}

# ---------- 1. the live feed ----------
Step 'The live feed (what the app will read)'
$feed = Join-Path $Out 'latest.yml'
Invoke-WebRequest -Uri $FeedUrl -OutFile $feed -UseBasicParsing
Invoke-WebRequest -Uri "$FeedUrl.sig" -OutFile "$feed.sig" -UseBasicParsing
Get-Content $feed | Write-Host
& node (Join-Path $RepoRoot 'scripts/publik-update-feed.cjs') verify $feed
if ($LASTEXITCODE -ne 0) { Fail "the live feed's signature does not verify with the app's public key" }
$liveVersion = ((Select-String -Path $feed -Pattern "^version: '(.*)'$").Matches[0].Groups[1].Value)
if ($liveVersion -ne $Expect) { Fail "publik serves $liveVersion, the run expects $Expect (start this run only when the feed serves $Expect)" }
Pass "publik's live feed serves $liveVersion, signed with the publik update key"
$feedSha = ((Select-String -Path $feed -Pattern "^\s+sha512: '(.*)'$").Matches[0].Groups[1].Value)

# ---------- 2. download and install as a user does ----------
Step "Download $Installer of $FromTag and install it"
$url = "https://github.com/$Repo/releases/download/$FromTag/$Installer"
$setup = Join-Path $Dl $Installer
Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing
$digest = (& gh api "repos/$Repo/releases/tags/$FromTag" --jq ".assets[] | select(.name == `"$Installer`") | .digest")
$have = 'sha256:' + (Get-FileHash -Algorithm SHA256 $setup).Hash.ToLower()
Write-Host "downloaded $((Get-Item $setup).Length) bytes, $have (release says $digest)"
if ($digest -and $digest -ne $have) { Fail "the downloaded installer does not match the release asset digest" }
if ((ExeVersion $setup) -ne $From) { Fail "the installer of $FromTag is version $(ExeVersion $setup)" }
$i = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
if ($i.ExitCode -ne 0) { Fail "the installer exited $($i.ExitCode)" }
Start-Sleep 3
Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force # a silent install does not start it; to be sure
$roots = @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles") | Where-Object { Test-Path $_ }
$exeItem = Get-ChildItem -Path $roots -Filter "$Name.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exeItem) { Fail 'the installed NitroAI.exe is not found' }
$script:Exe = $exeItem.FullName
if ((ExeVersion $script:Exe) -ne $From) { Fail "the installed exe is $(ExeVersion $script:Exe), not $From" }
$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like "$Name*" } | Select-Object -First 1
$apps = if ($reg) { "$($reg.DisplayName) $($reg.DisplayVersion)" } else { 'no entry' }
Pass "installed $($script:Exe), version $(ExeVersion $script:Exe) (Apps list: $apps)"

# ---------- 3. start; the updater talks to the live feed ----------
Step 'Start NitroAI and wait for the updater'
Clear-DnsClientCache -ErrorAction SilentlyContinue
$p1 = Launch 'run1'
Shot 'started'

if (-not $Update) {
  $done = WaitLog 'run1' 'is not available|Error' 300
  $log = LogText 'run1'
  Write-Host '--- app log (updater lines)'; ($log -split "`n" | Where-Object { $_ -match '\[updates\]' }) | Write-Host
  if ($log -notmatch "latest\.yml $([regex]::Escape($Expect)): signature OK") { Fail 'the app did not log a verified feed (see run1.*.log)' }
  Pass "the app read the live feed and verified its signature: $([regex]::Match($log, '\[updates\] latest\.yml [^\r\n]*signature OK[^\r\n]*').Value)"
  $line = [regex]::Match($log, 'Update for version [^\r\n]* is not available[^\r\n]*').Value
  if (-not $line) { Fail 'the app did not report "no update" in 300 s (see run1.*.log)' }
  if ($line -notmatch "version $([regex]::Escape($Expect)) is not available") { Fail "unexpected: $line" }
  Pass "the running app reports its version: $line"
  Start-Sleep 20
  $d = Dump
  $d | Set-Content (Join-Path $Out 'ui-after-check.txt')
  if ($d | Where-Object { $_ -like 'BUTTON Restart Now*' }) { Fail "an update question showed although $Expect is the newest" }
  $pending = Join-Path $UpdaterCache 'pending'
  if ((Test-Path $pending) -and (Get-ChildItem $pending -Filter *.exe -ErrorAction SilentlyContinue)) { Fail 'the updater downloaded an installer although there is no update' }
  Pass 'no update question, no download'
  if ($p1.HasExited) { Fail "the app stopped (pid $($p1.Id))" }
  Pass "the app stays on $Expect and keeps running (pid $($p1.Id))"
} else {
  $d = WaitDialog 'Restart Now' 600
  if (-not $d) {
    (LogText 'run1') | Write-Host
    Dump | Set-Content (Join-Path $Out 'ui-no-question.txt')
    Fail 'no "Restart Now" question within 600 s'
  }
  Start-Sleep 2; $d = Dump # the texts can come a moment after the buttons
  $d | Set-Content (Join-Path $Out 'update-question.txt')
  Shot 'update-question'
  $log = LogText 'run1'
  Write-Host '--- app log (updater lines)'; ($log -split "`n" | Where-Object { $_ -match '\[updates\]' }) | Write-Host
  $question = TextsOf $d
  if ($question -notlike "*$Name $Expect is ready to install.*") { Fail "unexpected question: $question" }
  Pass "the app downloaded $Expect by itself and asks: $question"
  if ($log -match "latest\.yml $([regex]::Escape($Expect)): signature OK") { Pass "feed verified by the app: $([regex]::Match($log, '\[updates\] latest\.yml [^\r\n]*signature OK[^\r\n]*').Value)" }
  else { Note 'the app log has no "signature OK" line (stdout of the app may not reach the log on Windows)' }
  $pendingFile = Join-Path $UpdaterCache "pending\$Installer"
  if (-not (Test-Path $pendingFile)) { Fail "no $pendingFile`: where did the update come from?" }
  if ((Sha512B64 $pendingFile) -ne $feedSha) { Fail 'the downloaded installer does not have the feed''s sha512' }
  if ((ExeVersion $pendingFile) -ne $Expect) { Fail "the downloaded installer is $(ExeVersion $pendingFile)" }
  Pass "the only new installer is the updater's own download $pendingFile (version $Expect, sha512 = the signed feed's)"
  if ((ExeVersion $script:Exe) -ne $From) { Fail 'the app changed before the answer' }

  if ($Variant -eq 'restart') {
    Step 'Answer Restart Now'
    $clicked = ClickButton 'Restart Now'
    Write-Host $clicked
    $clickTime = Get-Date
    if ($clicked -eq 'NOT-FOUND') {
      Note 'the question could not be clicked on this runner: close and reopen instead'
      CloseApp
      $end = (Get-Date).AddSeconds(300)
      while ((ExeVersion $script:Exe) -ne $Expect -and (Get-Date) -lt $end) { Start-Sleep 3 }
      $null = Launch 'run2'
    } else {
      Pass "answered the question: $clicked"
      if (-not $p1.WaitForExit(120000)) { Fail 'the app did not quit after Restart Now' }
      Pass "the old app (pid $($p1.Id)) quit after Restart Now"
      $end = (Get-Date).AddSeconds(300)
      $p2 = $null
      while ((Get-Date) -lt $end) {
        $p2 = MainProcess
        if ($p2 -and $p2.StartTime -gt $clickTime -and (ExeVersion $script:Exe) -eq $Expect) { break }
        $p2 = $null
        Start-Sleep 3
      }
      if ((ExeVersion $script:Exe) -ne $Expect) { Fail "after Restart Now the exe is $(ExeVersion $script:Exe), not $Expect" }
      if (-not $p2) { Fail 'the app did not start again after Restart Now (300 s)' }
      Pass "the installer ran and the app started again by itself (pid $($p2.Id), started $($p2.StartTime))"
    }
  } else {
    Step 'Answer Later'
    $clicked = ClickButton 'Later'
    Write-Host $clicked
    if ($clicked -eq 'NOT-FOUND') { Fail 'the Later button could not be clicked' }
    Pass "answered the question: $clicked"
    Start-Sleep 30
    if ($p1.HasExited) { Fail 'the app stopped after Later' }
    if ((ExeVersion $script:Exe) -ne $From) { Fail 'the exe changed while the app runs after Later' }
    Pass "after Later the app keeps running as $From (pid $($p1.Id)); nothing is installed yet"
    Shot 'after-later'
    Step 'Close the app: the update installs now'
    CloseApp
    Pass 'the app ended when its window was closed'
    $end = (Get-Date).AddSeconds(300)
    while ((ExeVersion $script:Exe) -ne $Expect -and (Get-Date) -lt $end) { Start-Sleep 3 }
    if ((ExeVersion $script:Exe) -ne $Expect) { Fail "300 s after the quit the exe is $(ExeVersion $script:Exe), not $Expect" }
    Pass "the update installed at quit: the exe is $Expect"
    Start-Sleep 5
    $null = Launch 'run2'
  }
}

# ---------- 4. the app after ----------
Step 'The app now'
$now = MainProcess
if (-not $now) { Fail 'NitroAI does not run' }
if ((ExeVersion $script:Exe) -ne $Expect) { Fail "the exe is $(ExeVersion $script:Exe), not $Expect" }
Pass "NitroAI.exe ProductVersion $(ExeVersion $script:Exe)"
$runningVersion = Norm $now.MainModule.FileVersionInfo.ProductVersion
if ($now.Path -ne $script:Exe) { Fail "the running NitroAI is $($now.Path), not $($script:Exe)" }
if ($runningVersion -ne $Expect) { Fail "the running process is version $runningVersion" }
if ($Update -and $now.Id -eq $p1.Id) { Fail "the running process is still the one of $From" }
Pass "running: pid $($now.Id), started $($now.StartTime), $($now.Path), version $runningVersion"
$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like "$Name*" } | Select-Object -First 1
if ($reg -and (Norm $reg.DisplayVersion) -ne $Expect) { Fail "Apps list says $($reg.DisplayVersion)" }
if (Test-Path (Join-Path $Out 'run2.out.log')) {
  if (WaitLog 'run2' 'is not available' 180) {
    $line = [regex]::Match((LogText 'run2'), 'Update for version [^\r\n]* is not available[^\r\n]*').Value
    if ($line -notmatch "version $([regex]::Escape($Expect)) is not available") { Fail "run2: $line" }
    Pass "the running app's log: $line"
  } else { Fail "run2: no `"$Expect is not available`" line (see run2.*.log)" }
} else { Start-Sleep 20 }

Step 'Help › Check for Updates… (best effort on Windows)'
$m = TryMenuCheck
Write-Host "menu: $m"
if ($m -eq 'CLICKED') {
  $d = WaitDialog 'OK' 120
  if ($d) { Start-Sleep 2; $d = Dump } # the texts can come a moment after the button
  if (-not $d) { Note 'Check for Updates… was clicked but no answer showed in 120 s'; Dump | Set-Content (Join-Path $Out 'menu-check-ui.txt') }
  else {
    $d | Set-Content (Join-Path $Out 'menu-check-dialog.txt')
    Shot 'menu-check-answer'
    $msg = TextsOf $d
    if ($msg -notlike "*up to date*" -or $msg -notlike "*$Name $Expect is the newest version.*") { Fail "Check for Updates… answered: $msg" }
    Pass "Check for Updates… (Help menu, UI Automation) answered: $msg"
    $null = ClickButton 'OK'
  }
} else {
  Note "the Help menu could not be driven on this runner ($m); the handler is covered by test/publik-updater-schedule.test.mjs and the macOS jobs"
}

# ---------- 5. nothing downloaded by hand ----------
Step 'No manual download'
# Installer-like files (the installer's Desktop shortcut NitroAI.lnk is not one).
$others = @(Get-ChildItem -Path "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Desktop", $env:TEMP -Filter '*NitroAI*' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.exe', '.zip', '.7z', '.msi', '.dmg' } | ForEach-Object FullName)
Write-Host "installer files named NitroAI outside the updater cache: $(if ($others.Count) { $others -join ', ' } else { 'none' })"
if ($others.Count) { Fail "unexpected installer files: $($others -join ', ')" }
Pass "the only installer this job downloaded is $Installer of $FromTag; any update file came from the app's updater ($UpdaterCache)"

CloseApp
Collect
$dns = Get-Content (Join-Path $Out 'dns-cache.txt') -ErrorAction SilentlyContinue | Where-Object { $_ -match 'publikhq|github' }
foreach ($l in $dns) { "DNS cache: $($l.Trim())" | Tee-Object -FilePath $Results -Append | Write-Host }
Write-Host "`n==== assertions"
Get-Content $Results | Write-Host
