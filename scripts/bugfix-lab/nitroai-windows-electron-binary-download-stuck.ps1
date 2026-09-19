<#
 Oracle harness for cluster nitroai-windows-electron-binary-download-stuck.

 Reproduces the guide's Windows "package" step (id: package, command
 `npm.cmd run dist:win`) exactly as a reader following
 ~/publik/lib/guides/nitroai.ts version 11 would run it, on a clean runner
 with no pre-existing electron/electron-builder cache, and times how long
 the terminal sits at the "Downloading Electron binary..." line with no
 further output.

 -Mode clean         : nothing else running (the literal guide path).
 -Mode precondition   : an already-installed, already-running NitroAI.exe
                         window is left open first (the reporters' own
                         workaround was "close NitroAI, not PowerShell" —
                         this mode tests whether a running instance is what
                         blocks the shell, per the cluster's proposed oracle).

 Prints BUGFIX_LAB_PRESENT / BUGFIX_LAB_ABSENT and exits 1 / 0 accordingly.
 Exit 2 = the harness itself could not run the step (setup failure, not the
 reported symptom).
#>

param(
    [ValidateSet("clean", "precondition")]
    [string]$Mode = "clean",

    [int]$TimeoutSeconds = 600,

    [int]$PollSeconds = 10
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $repoRoot

Write-Host "=== nitroai-windows-electron-binary-download-stuck oracle ==="
Write-Host "Mode: $Mode"
Write-Host "Repo root: $repoRoot"
Write-Host "HEAD: $(git rev-parse HEAD)"

# --- Step 0: force a genuinely clean electron / electron-builder cache, as
# the cluster's proposed oracle asks ("clear %LOCALAPPDATA%\electron-builder\Cache
# first"). Also clear npm's own electron postinstall cache so the download this
# script observes is a real, uncached download and not a reuse from an earlier
# run on the same runner. ---
$cachesToClear = @(
    "$env:LOCALAPPDATA\electron-builder\Cache",
    "$env:LOCALAPPDATA\electron\Cache"
)
foreach ($c in $cachesToClear) {
    if (Test-Path $c) {
        Write-Host "Clearing cache: $c"
        Remove-Item -Recurse -Force $c -ErrorAction SilentlyContinue
    }
}

# --- Step 1: install dependencies (guide step 'dependencies', `npm.cmd ci`) ---
Write-Host "`n--- npm.cmd ci ---"
& npm.cmd ci
if ($LASTEXITCODE -ne 0) {
    Write-Host "BUGFIX_LAB_ABSENT (harness setup failed: npm ci exited $LASTEXITCODE, not the reported symptom)"
    exit 2
}

# --- Step 2 (precondition mode only): install and launch a real, already-
# packaged NitroAI so an old app window is open BEFORE the package step runs,
# exactly as the workaround report describes ("close out NitroAI (NOT
# POWERSHELL)... frees the shell"). Uses the latest published Windows
# installer so this is a real NitroAI.exe, not a stand-in process. ---
$preApp = $null
if ($Mode -eq "precondition") {
    Write-Host "`n--- precondition: installing + launching a prior NitroAI build ---"
    $setupUrl = "https://github.com/Blueturboguy07/NitroAI/releases/latest/download/NitroAI-Setup-Windows.exe"
    $setupPath = "$env:RUNNER_TEMP\NitroAI-Setup-Windows-prior.exe"
    Invoke-WebRequest -Uri $setupUrl -OutFile $setupPath -TimeoutSec 180
    Write-Host "Downloaded prior installer to $setupPath"
    $install = Start-Process -FilePath $setupPath -ArgumentList "/S" -PassThru
    $install.WaitForExit()
    Write-Host "Prior installer exit code: $($install.ExitCode)"
    Start-Sleep -Seconds 5
    $exePath = "$env:LOCALAPPDATA\Programs\NitroAI\NitroAI.exe"
    if (-not (Test-Path $exePath)) {
        Write-Host "BUGFIX_LAB_ABSENT (harness setup failed: prior NitroAI.exe not found after silent install, not the reported symptom)"
        exit 2
    }
    $preApp = Start-Process -FilePath $exePath -PassThru
    Start-Sleep -Seconds 8
    $running = Get-Process -Id $preApp.Id -ErrorAction SilentlyContinue
    if (-not $running) {
        Write-Host "BUGFIX_LAB_ABSENT (harness setup failed: prior NitroAI.exe did not stay running, not the reported symptom)"
        exit 2
    }
    Write-Host "Prior NitroAI.exe is running (pid $($preApp.Id)) before the package step starts."
}

# --- Step 3: the package step itself (`npm.cmd run dist:win`), run as a
# child process whose combined stdout/stderr we poll via redirected log
# files (NOT .NET async output EVENTS — PowerShell event-handler scriptblocks
# run in their own scope and silently cannot see this script's local
# variables, which produced an empty buffer and a false read on the first
# attempt at this oracle; file redirection has no such scoping trap), so we
# can time how long it sits at 'Downloading Electron binary...' without
# acting on the output ourselves (matches the reporter: a human just
# watching the shell). ---
Write-Host "`n--- npm.cmd run dist:win ---"
if (Test-Path release) { Remove-Item -Recurse -Force release -ErrorAction SilentlyContinue }

$stdoutLog = "$env:RUNNER_TEMP\dist-win-stdout.log"
$stderrLog = "$env:RUNNER_TEMP\dist-win-stderr.log"
Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

# Launched via cmd.exe /c so this behaves identically to a person typing the
# guide's literal command into a console, regardless of .NET's handling of
# .cmd batch files under ProcessStartInfo.
$proc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "npm.cmd run dist:win" `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru -NoNewWindow

function Get-CombinedOutput {
    $text = ""
    if (Test-Path $stdoutLog) { $text += (Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path $stderrLog) { $text += (Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue) }
    return $text
}

$startTime = Get-Date
$sawDownloadLine = $false
$lastLen = 0
$lastProgressAt = $startTime
$elapsed = New-TimeSpan

while ($true) {
    Start-Sleep -Seconds $PollSeconds
    $elapsed = (Get-Date) - $startTime

    $snapshot = Get-CombinedOutput

    if (-not $sawDownloadLine -and $snapshot -match "Downloading Electron binary") {
        $sawDownloadLine = $true
        Write-Host "[$([int]$elapsed.TotalSeconds)s] saw 'Downloading Electron binary...' — starting stall timer"
        $lastProgressAt = Get-Date
        $lastLen = $snapshot.Length
    } elseif ($sawDownloadLine -and $snapshot.Length -gt $lastLen) {
        $lastProgressAt = Get-Date
        $lastLen = $snapshot.Length
    }

    $proc.Refresh()
    if ($proc.HasExited) { break }

    if ($sawDownloadLine) {
        $stallSeconds = ((Get-Date) - $lastProgressAt).TotalSeconds
        if ($stallSeconds -ge $TimeoutSeconds) {
            Write-Host "`n[$([int]$elapsed.TotalSeconds)s] no output change for $([int]$stallSeconds)s after 'Downloading Electron binary...' — treating as PRESENT"
            break
        }
    } elseif ($elapsed.TotalSeconds -ge $TimeoutSeconds) {
        Write-Host "`n[$([int]$elapsed.TotalSeconds)s] never even reached 'Downloading Electron binary...' within timeout"
        break
    }
}

$finalOutput = Get-CombinedOutput
$hung = $sawDownloadLine -and (-not $proc.HasExited)
$exitCode = $null

if (-not $proc.HasExited) {
    Write-Host "Killing still-running dist:win process tree (pid $($proc.Id))"
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Seconds 2
    Get-Process npm, electron-builder, node -ErrorAction SilentlyContinue |
        Where-Object { $_.StartTime -ge $startTime } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }
} else {
    $exitCode = $proc.ExitCode
}

if ($preApp) {
    try { Stop-Process -Id $preApp.Id -Force -ErrorAction SilentlyContinue } catch {}
}

Write-Host "`n=== last 60 lines of dist:win output ==="
($finalOutput -split "`r?`n") | Select-Object -Last 60 | ForEach-Object { Write-Host $_ }
Write-Host "=== exit code (if process exited): $(if ($null -ne $exitCode) { $exitCode } else { 'never exited (killed)' }) ==="

$installerBuilt = Test-Path "release\NitroAI-Setup-Windows.exe"

if ($hung -and -not $installerBuilt) {
    Write-Host "`nBUGFIX_LAB_PRESENT"
    Write-Host "Evidence: mode=$Mode, saw 'Downloading Electron binary...' at ~$([int]($lastProgressAt - $startTime).TotalSeconds -as [int])s-ish, then no output growth for >= $TimeoutSeconds s, process still running when killed, no installer produced in release\."
    exit 1
} elseif ($exitCode -eq 0 -and $installerBuilt) {
    Write-Host "`nBUGFIX_LAB_ABSENT"
    Write-Host "Evidence: mode=$Mode, dist:win completed in $([int]$elapsed.TotalSeconds)s, release\NitroAI-Setup-Windows.exe exists."
    exit 0
} else {
    Write-Host "`nBUGFIX_LAB_ABSENT (did not reproduce the specific hang; process exit code=$(if ($null -ne $exitCode) { $exitCode } else { 'n/a' }), installerBuilt=$installerBuilt — a different failure, not 'hangs with no progress/error')"
    exit 0
}
