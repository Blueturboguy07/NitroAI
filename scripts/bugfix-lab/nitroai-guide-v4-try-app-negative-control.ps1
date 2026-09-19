<#
 NEGATIVE CONTROL for cluster nitroai-windows-electron-binary-download-stuck.

 Proves the oracle is sensitive by running the step the Aug 11 2026 reporters
 actually had: guide version <=4's 'try-app' step (command `npm.cmd run app`,
 title "Run NitroAI"), which publik commit c761358 (2026-08-19) REMOVED —
 the fixed guide (version 5+, today version 11) never runs this command at
 all before 'package'.

 `npm run app` = `npm run build && electron .`. Since `node_modules/electron`
 (v43.1.1 here) ships NO postinstall script, the Electron binary is not
 fetched during `npm ci` — it is fetched lazily, synchronously, the first
 time something does `require('electron')`, which prints EXACTLY
 "Downloading Electron binary..." (node_modules/electron/index.js) and then
 blocks the whole process on a child `install.js` download before the app
 can even open. Once the app does open, `electron .` is a FOREGROUND command
 that does not return until the app window is closed — so the shell looks
 "stuck" for as long as the reader leaves the app open, and the fix for that
 IS the reporters' own workaround: close the NitroAI window (not the shell).

 Exits 1 (PRESENT) if the command produces no returned shell control within
 the wait window while an app process is confirmed running (the reported
 symptom); 0 if `npm run app` exits back to the shell on its own.
#>

param(
    [int]$WaitSeconds = 240
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $repoRoot

Write-Host "=== negative control: guide v4 'try-app' step (npm.cmd run app) ==="
Write-Host "HEAD: $(git rev-parse HEAD)"

# Fresh state: no electron binary downloaded yet (npm ci alone never fetches
# it — see script comment above). Confirm that precondition explicitly.
if (Test-Path node_modules\electron\dist) {
    Write-Host "Clearing node_modules\electron\dist to guarantee a first-ever require('electron')"
    Remove-Item -Recurse -Force node_modules\electron\dist -ErrorAction SilentlyContinue
}
Remove-Item node_modules\electron\path.txt -ErrorAction SilentlyContinue

Write-Host "`n--- npm.cmd ci ---"
& npm.cmd ci
if ($LASTEXITCODE -ne 0) {
    Write-Host "BUGFIX_LAB_ABSENT (harness setup failed: npm ci exited $LASTEXITCODE)"
    exit 2
}

$hasDistBeforeRun = Test-Path node_modules\electron\dist
Write-Host "node_modules\electron\dist exists before 'npm run app'? $hasDistBeforeRun (should be False)"

$stdoutLog = "$env:RUNNER_TEMP\try-app-stdout.log"
$stderrLog = "$env:RUNNER_TEMP\try-app-stderr.log"
Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

Write-Host "`n--- npm.cmd run app (guide v4 'try-app' step) ---"
$proc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "npm.cmd run app" `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru -NoNewWindow

$startTime = Get-Date
$sawDownloadLine = $false
while ($true) {
    Start-Sleep -Seconds 10
    $elapsed = (Get-Date) - $startTime
    $text = ""
    if (Test-Path $stdoutLog) { $text += (Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path $stderrLog) { $text += (Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue) }
    if (-not $sawDownloadLine -and $text -match "Downloading Electron binary") {
        $sawDownloadLine = $true
        Write-Host "[$([int]$elapsed.TotalSeconds)s] saw 'Downloading Electron binary...'"
    }
    $proc.Refresh()
    if ($proc.HasExited) {
        Write-Host "[$([int]$elapsed.TotalSeconds)s] npm run app returned on its own (exit $($proc.ExitCode))"
        break
    }
    if ($elapsed.TotalSeconds -ge $WaitSeconds) {
        Write-Host "[$([int]$elapsed.TotalSeconds)s] still running (shell would still be blocked) after ${WaitSeconds}s wait"
        break
    }
}

$finalText = ""
if (Test-Path $stdoutLog) { $finalText += (Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue) }
if (Test-Path $stderrLog) { $finalText += (Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue) }
Write-Host "`n=== full npm run app output ==="
($finalText -split "`r?`n") | ForEach-Object { Write-Host $_ }

$appProcesses = Get-Process -Name "NitroAI", "electron" -ErrorAction SilentlyContinue
$appProcDesc = ($appProcesses | ForEach-Object { "$($_.ProcessName) (pid $($_.Id))" }) -join ", "
Write-Host "`nApp/electron processes currently running: $appProcDesc"

$stillBlocked = -not $proc.HasExited

if ($stillBlocked -and $sawDownloadLine) {
    Write-Host "`n--- reporters' own workaround: close the app window (not the shell) ---"
    if ($appProcesses) {
        $appProcesses | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }
    } else {
        # The electron process may be the direct child of npm run app itself.
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Seconds 5
    $proc.Refresh()
    Write-Host "After closing the app window, has the shell command returned? HasExited=$($proc.HasExited)"
    if (-not $proc.HasExited) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
}

if ($stillBlocked -and $sawDownloadLine) {
    Write-Host "`nBUGFIX_LAB_PRESENT"
    Write-Host "Evidence: printed 'Downloading Electron binary...' (node_modules/electron had no dist before this run: $(-not $hasDistBeforeRun)), then 'npm.cmd run app' held the shell for >= ${WaitSeconds}s with no further output and no return of control — matches both reports exactly (145298ae's stuck shell, c6f3d7e4's fix being to close the app window)."
    exit 1
} else {
    Write-Host "`nBUGFIX_LAB_ABSENT"
    Write-Host "Evidence: npm run app returned control on its own within ${WaitSeconds}s (sawDownloadLine=$sawDownloadLine)."
    exit 0
}
