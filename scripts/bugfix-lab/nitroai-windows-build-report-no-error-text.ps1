# Oracle script for cluster nitroai-windows-build-report-no-error-text.
# Reproduces exactly the two commands the reporter gave (report eb1f2a11):
#   cd ~/NitroAI
#   npm.cmd run dist:win
# on a fresh Windows runner, cloning NitroAI at the guide's pinned sourceCommit
# (the commit guide-installers actually check out via the "Use the reviewed
# version" step), then running `npm.cmd ci` (the guide's "Install dependencies"
# step, which must precede dist:win for node_modules/electron-builder to exist)
# followed by `npm.cmd run dist:win`.
#
# Presence bar (per the cluster's oracle spec): the report supplies no specific
# error text, so PRESENT = any non-zero exit / crash from the documented
# command, ABSENT = it completes and produces the Windows installer.
#
# Prints BUGFIX_LAB_PRESENT / BUGFIX_LAB_ABSENT and exits 1 / 0 accordingly.
# Exits 2 if the oracle itself could not run (e.g. clone/checkout failed).

$ErrorActionPreference = "Stop"
$PINNED_SHA = "4df4aaee787ee09b9b5062119e37b4a9816fa808"
$CLONE_URL = "https://github.com/Blueturboguy07/NitroAI.git"

Set-Location $env:USERPROFILE
Write-Host "== clone =="
git clone $CLONE_URL NitroAI 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "BUGFIX_LAB_ORACLE_ERROR clone failed"
    exit 2
}

Set-Location "$env:USERPROFILE\NitroAI"
Write-Host "== checkout pinned commit $PINNED_SHA =="
git checkout $PINNED_SHA 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "BUGFIX_LAB_ORACLE_ERROR checkout failed"
    exit 2
}
git rev-parse HEAD

Write-Host "== npm.cmd ci =="
$ciOut = & npm.cmd ci 2>&1 | Tee-Object -Variable ciOutVar
$ciExit = $LASTEXITCODE
$ciOutVar | Write-Host
Write-Host "npm.cmd ci exit code: $ciExit"
if ($ciExit -ne 0) {
    Write-Host "BUGFIX_LAB_PRESENT"
    Write-Host "Evidence: npm.cmd ci (the guide's Install dependencies step, a prerequisite for dist:win) failed with exit $ciExit before dist:win could even run."
    exit 1
}

Write-Host "== npm.cmd run dist:win (the reporter's exact second command) =="
$distOut = & npm.cmd run dist:win 2>&1 | Tee-Object -Variable distOutVar
$distExit = $LASTEXITCODE
$distOutVar | Write-Host
Write-Host "npm.cmd run dist:win exit code: $distExit"

$installerPath = "$env:USERPROFILE\NitroAI\release\NitroAI-Setup-Windows.exe"
$installerExists = Test-Path $installerPath

if ($distExit -ne 0 -or -not $installerExists) {
    Write-Host "BUGFIX_LAB_PRESENT"
    Write-Host "Evidence: npm.cmd run dist:win exit=$distExit; installer present at $installerPath : $installerExists"
    Write-Host "== last 80 lines of dist:win output =="
    $distOutVar | Select-Object -Last 80 | Write-Host
    exit 1
} else {
    Write-Host "BUGFIX_LAB_ABSENT"
    Write-Host "Evidence: npm.cmd run dist:win exit=0; installer present at $installerPath : $installerExists"
    exit 0
}
