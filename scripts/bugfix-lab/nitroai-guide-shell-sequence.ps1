# bugfix-lab | cluster: nitroai-windows-electron-binary-download-stuck
#
# Observes the failure the REPORTERS describe, which is NOT "one command hangs" but
# "PowerShell is unusable when I get to the Build-the-installer step":
#
#   145298ae: "step 11 to build the installer / Powershell stuck 'Downloading Electron
#              Binary...' / cannot use power shell at all to create the installer"
#   c6f3d7e4: "just close out NitroAI (NOT POWERSHELL) and then powershell will be
#              accessible again for step 12"
#
# So this harness runs the guide's Windows commands the way a reader does: ONE shell
# session, steps in order, each step only able to run once the previous one gave the
# shell back. A step that never returns strands every later step - which is the bug.
#
# -Mode today : today's live guide (publik main, nitroai guide version 11) step order
# -Mode v3    : the guide version that was live at the reports' timestamps (publik
#               b9e2b4136536f6ec46c163a176f583b85ca5ec2e, nitroai guide version 3),
#               which carried a `try-app` step (`npm.cmd run app`) before `package`.
#
# Prints BUGFIX_LAB_PRESENT + exit 1 when the session never completes the
# "Build the installer" step, BUGFIX_LAB_ABSENT + exit 0 when it does.

param([ValidateSet('today', 'v3')][string]$Mode = 'today')

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Say($m) { Write-Host ("[{0,5:N0}s] {1}" -f $script:sw.Elapsed.TotalSeconds, $m) }
$script:sw = [System.Diagnostics.Stopwatch]::StartNew()

$work = Join-Path $env:RUNNER_TEMP 'guide-seq'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null
$sessionScript = Join-Path $work 'session.ps1'
$outFile = Join-Path $work 'session.out'
$errFile = Join-Path $work 'session.err'

# --- clean machine: no clone, no electron caches, no electron-builder cache ----------
Say "Mode = $Mode"
foreach ($p in @(
    (Join-Path $env:USERPROFILE 'NitroAI'),
    (Join-Path $env:LOCALAPPDATA 'electron\Cache'),
    (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'))) {
  if (Test-Path $p) { Say "clearing $p"; Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}

# --- the guide steps, verbatim ------------------------------------------------------
# The clone step is authored POSIX in publik; Iris rewrites it for PowerShell via
# translatePosixShellToPowerShell() in iris-windows/src/services/autopilot/guide-recipe.ts.
# That derived PowerShell form is what a Windows reader/Iris actually runs, so it is
# what is used here.
$cloneDerived = @'
cd ~
if (-not (Test-Path NitroAI/.git)) {
git clone https://github.com/Blueturboguy07/NitroAI.git
}
'@

$pinSource = @'
$origin = git config --get remote.origin.url 2>$null
if ($origin) { $origin = $origin -replace '^git@github\.com:', 'https://github.com/' -replace '\.git$', '' }
$dirty = git status --porcelain 2>$null
if ($origin -ne "https://github.com/Blueturboguy07/NitroAI" -or $dirty) {
  Write-Host "~/NitroAI already exists and is not a clean copy of this app's source. Move or rename that folder, then press Try again."
  exit 1
}
git checkout 4df4aaee787ee09b9b5062119e37b4a9816fa808
'@

# guide v3's pin-source was the plain checkout (the PowerShell guard arrived 2026-09-05)
$pinSourceV3 = 'git checkout 4df4aaee787ee09b9b5062119e37b4a9816fa808'

$checkTools = "git --version`nnode --version"

if ($Mode -eq 'v3') {
  # publik b9e2b413, nitroai guide version 3, windows branch, reader-facing numbers
  $steps = @(
    @{ id = 'check-tools';  n = 4;  cmd = $checkTools },
    @{ id = 'clone';        n = 5;  cmd = "cd ~`ngit clone https://github.com/Blueturboguy07/NitroAI.git" },
    @{ id = 'enter-folder'; n = 6;  cmd = 'cd NitroAI' },
    @{ id = 'pin-source';   n = 7;  cmd = $pinSourceV3 },
    @{ id = 'dependencies'; n = 8;  cmd = 'npm.cmd ci' },
    @{ id = 'try-app';      n = 9;  cmd = 'npm.cmd run app' },
    @{ id = 'package';      n = 11; cmd = 'npm.cmd run dist:win' }
  )
} else {
  # publik main, nitroai guide version 11, windows branch, reader-facing numbers
  $steps = @(
    @{ id = 'check-tools';  n = 4; cmd = $checkTools },
    @{ id = 'clone';        n = 5; cmd = $cloneDerived },
    @{ id = 'enter-folder'; n = 6; cmd = 'cd NitroAI' },
    @{ id = 'pin-source';   n = 7; cmd = $pinSource },
    @{ id = 'dependencies'; n = 8; cmd = 'npm.cmd ci' },
    @{ id = 'package';      n = 9; cmd = 'npm.cmd run dist:win' }
  )
}

# The step whose completion the reporters could not reach.
$targetId = 'package'
$targetN = ($steps | Where-Object { $_.id -eq $targetId }).n

# --- build the one script the one shell runs ----------------------------------------
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('$ErrorActionPreference = "Continue"')
foreach ($s in $steps) {
  $lines.Add("Write-Host ""BUGFIX_LAB_STEP_START $($s.id) (guide step $($s.n))""")
  foreach ($l in ($s.cmd -split "`n")) { $lines.Add($l) }
  $lines.Add("Write-Host ""BUGFIX_LAB_STEP_DONE $($s.id)""")
}
$lines.Add('Write-Host "BUGFIX_LAB_SESSION_END"')
Set-Content -Path $sessionScript -Value ($lines -join "`r`n") -Encoding UTF8
Say "session script written ($($steps.Count) guide steps, target = step $targetN '$targetId')"

New-Item -ItemType File -Force -Path $outFile, $errFile | Out-Null
$proc = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', $sessionScript `
  -WorkingDirectory $env:USERPROFILE `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
  -PassThru -WindowStyle Hidden
Say "one PowerShell session started (pid $($proc.Id)) - this is the reader's shell"

# --- watch that single session ------------------------------------------------------
$overallDeadline = (Get-Date).AddSeconds(1800)
$stepBudget = 600          # seconds any single guide step gets before it counts as stranding the shell
                           # (the cluster's proposed oracle: "no progress or completion within ~10 minutes")
$current = $null
$currentSince = Get-Date
$done = @{}
$sawDownloadLine = $false
$blockedAt = $null

# The child holds the file open for writing, so open it with FileShare.ReadWrite rather
# than Get-Content (which would intermittently throw a sharing violation and silently
# hand back an empty string - the same class of false-empty-read the first attempt hit).
function Read-Out {
  if (-not (Test-Path $outFile)) { return '' }
  try {
    $fs = [System.IO.File]::Open($outFile, 'Open', 'Read', 'ReadWrite')
    try { (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
  } catch { '' }
}

while ($true) {
  Start-Sleep -Seconds 5
  $text = Read-Out
  if ($text -and -not $sawDownloadLine -and $text -match 'Downloading Electron binary') {
    $sawDownloadLine = $true
    Say "session printed 'Downloading Electron binary...' (the line in report 145298ae's screenshot)"
  }
  foreach ($s in $steps) {
    if ($text -match [regex]::Escape("BUGFIX_LAB_STEP_START $($s.id) ") -and $current -ne $s.id -and -not $done.ContainsKey($s.id)) {
      $current = $s.id; $currentSince = Get-Date
      Say "shell reached guide step $($s.n) '$($s.id)'"
    }
    if ($text -match [regex]::Escape("BUGFIX_LAB_STEP_DONE $($s.id)") -and -not $done.ContainsKey($s.id)) {
      $done[$s.id] = $true
      Say "shell RETURNED from guide step $($s.n) '$($s.id)' - prompt is free"
    }
  }
  if ($done.ContainsKey($targetId)) { break }
  if ($proc.HasExited) { Say "session process exited (code $($proc.ExitCode)) without completing '$targetId'"; break }
  if ($current -and -not $done.ContainsKey($current) -and ((Get-Date) - $currentSince).TotalSeconds -gt $stepBudget) {
    $blockedAt = $current
    Say "guide step '$current' has held the ONLY shell for > $stepBudget s and never gave it back"
    break
  }
  if ((Get-Date) -gt $overallDeadline) { $blockedAt = $current; Say 'overall deadline hit'; break }
}

$text = Read-Out
$reachedTarget = $text -match [regex]::Escape("BUGFIX_LAB_STEP_START $targetId ")
$completedTarget = $done.ContainsKey($targetId)
$installer = Join-Path $env:USERPROFILE 'NitroAI\release\NitroAI-Setup-Windows.exe'

Say "--- observed state ---"
Say "reached step $targetN '$targetId' in this shell : $reachedTarget"
Say "completed step $targetN '$targetId'             : $completedTarget"
Say "installer present ($installer)                  : $(Test-Path $installer)"
Say "printed 'Downloading Electron binary...'        : $sawDownloadLine"
if ($blockedAt) { Say "shell stranded at step '$blockedAt'" }

# --- reporter c6f3d7e4's workaround, as an experiment --------------------------------
# "close out NitroAI (NOT POWERSHELL) and then powershell will be accessible again for step 12"
$workaroundFreedShell = $null
if (-not $completedTarget -and -not $proc.HasExited) {
  $electrons = @(Get-Process -Name electron, NitroAI -ErrorAction SilentlyContinue)
  Say "app processes currently alive: $(($electrons | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ', ')"
  if ($electrons.Count -gt 0) {
    Say "applying report c6f3d7e4's workaround: closing the NitroAI/Electron windows, NOT PowerShell"
    $electrons | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    $freeBy = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $freeBy) {
      Start-Sleep -Seconds 5
      $text = Read-Out
      if ($text -match [regex]::Escape("BUGFIX_LAB_STEP_START $targetId ")) { break }
    }
    $workaroundFreedShell = [bool]($text -match [regex]::Escape("BUGFIX_LAB_STEP_START $targetId "))
    Say "after closing the app, did the SAME shell move on to step $targetN '$targetId'? $workaroundFreedShell"
  }
}

# tidy up so the runner does not hang on a live child, and so the log files are closed
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Get-Process -Name electron, NitroAI, node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Say '--- last 60 lines the reader would see in that shell ---'
if (Test-Path $outFile) { Get-Content $outFile -Tail 60 | ForEach-Object { Write-Host "  | $_" } }
if ((Test-Path $errFile) -and (Get-Item $errFile).Length -gt 0) {
  Say '--- stderr tail ---'
  Get-Content $errFile -Tail 30 | ForEach-Object { Write-Host "  ! $_" }
}

if ($completedTarget -and (Test-Path $installer)) {
  Write-Host 'BUGFIX_LAB_ABSENT'
  Write-Host "Evidence: one PowerShell session ran guide ($Mode) steps in order and reached AND completed step $targetN 'Build the installer' ($([int]$sw.Elapsed.TotalSeconds)s total); NitroAI-Setup-Windows.exe exists. The shell was never taken away from the reader."
  exit 0
}
Write-Host 'BUGFIX_LAB_PRESENT'
Write-Host "Evidence: one PowerShell session ran guide ($Mode) steps in order. It never completed step $targetN 'Build the installer' (reached=$reachedTarget, completed=$completedTarget); the shell was stranded at step '$blockedAt'. Printed 'Downloading Electron binary...': $sawDownloadLine. Closing the NitroAI app freed the same shell: $workaroundFreedShell."
exit 1
