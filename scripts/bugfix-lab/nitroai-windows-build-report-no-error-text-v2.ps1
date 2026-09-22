# Oracle v2 for cluster nitroai-windows-build-report-no-error-text.
#
# DIFFERENT ANGLE from v1 (which did a plain `git clone` + `git checkout <pinned-sha>`
# + `npm.cmd ci` + `npm.cmd run dist:win`, bypassing the guide's own clone step, and
# came back BUGFIX_LAB_ABSENT / not_reproduced).
#
# v2 instead replays the LIVE Windows guide session a real reader actually gets,
# starting from the "clone" step (lib/guides/nitroai.ts, step id "clone"), whose
# command text on origin/main today is still the unbranched POSIX form:
#   cd ~
#   if [ ! -d NitroAI/.git ]; then
#   git clone https://github.com/Blueturboguy07/NitroAI.git
#   fi
# with NO isMac ternary (confirmed via render-guide.mts against origin/main HEAD
# and via `git show origin/main:lib/guides/nitroai.ts`). A sibling cluster
# (cue-clone-step-posix-if-windows-parsererror, break 4eebe542, PR
# https://github.com/Blueturboguy07/publik/pull/3, still UNMERGED as of today)
# independently proved this exact command ParserErrors in real PowerShell on
# windows-latest and leaves the NitroAI folder never created, 3/3 runs.
#
# This oracle continues from there exactly like the reporter's own two-line
# report: after the clone step (mis)fires, it runs
#   cd ~/NitroAI
#   npm.cmd run dist:win
# (the report's own literal text) in a fresh PowerShell process, matching a
# real reader whose prompt returned after the ParserError and who then either
# followed the guide (enter-folder -> ... -> package) or, per the report body,
# jumped straight to those two lines.
#
# PRESENT (exit 1) = the clone step does not leave a real NitroAI/.git working
#   tree AND/OR the reporter's own two commands then fail — matching the
#   cluster's own presence bar ("does the documented command even succeed").
# ABSENT (exit 0) = NitroAI got cloned and dist:win completed with an installer.
# exit 2 = oracle itself could not run.

$PINNED_SHA = "4df4aaee787ee09b9b5062119e37b4a9816fa808"
Set-Location $env:USERPROFILE
if (Test-Path "$env:USERPROFILE\NitroAI") {
    Remove-Item -Recurse -Force "$env:USERPROFILE\NitroAI"
}

Write-Host "== STEP: clone (guide step id 'clone', windows branch, command as rendered from origin/main today) =="
# Literal command text, byte-for-byte from lib/guides/nitroai.ts nitroSteps() "clone" step,
# windows branch (no isMac ternary exists on this step today).
$cloneCmd = "cd ~`nif [ ! -d NitroAI/.git ]; then`ngit clone https://github.com/Blueturboguy07/NitroAI.git`nfi"
Write-Host "--- command text sent to a fresh PowerShell process ---"
Write-Host $cloneCmd
Write-Host "--- output ---"
$cloneOut = & pwsh -NoProfile -Command $cloneCmd 2>&1 | Out-String
Write-Host $cloneOut
$cloneExit = $LASTEXITCODE
Write-Host "clone step exit code (of the nested pwsh -Command process): $cloneExit"

$clonedOk = Test-Path "$env:USERPROFILE\NitroAI\.git"
Write-Host "NitroAI\.git exists after clone step: $clonedOk"

$parserErrorSeen = $cloneOut -match "MissingOpenParenthesisInIfStatement|Missing '\(' after 'if' in if statement"
Write-Host "PowerShell ParserError signature seen: $parserErrorSeen"

Write-Host ""
Write-Host "== STEP: reporter's own two commands (report eb1f2a11), run in a fresh PowerShell process =="
$reportCmd = "cd ~/NitroAI`nnpm.cmd run dist:win"
Write-Host "--- command text ---"
Write-Host $reportCmd
Write-Host "--- output ---"
$reportOut = & pwsh -NoProfile -Command $reportCmd 2>&1 | Out-String
Write-Host $reportOut
$reportExit = $LASTEXITCODE
Write-Host "reporter-command step exit code: $reportExit"

$installerPath = "$env:USERPROFILE\NitroAI\release\NitroAI-Setup-Windows.exe"
$installerExists = Test-Path $installerPath
Write-Host "installer present: $installerExists"

if (-not $clonedOk -or $reportExit -ne 0 -or -not $installerExists) {
    Write-Host "BUGFIX_LAB_PRESENT"
    Write-Host "Evidence: clone-step left NitroAI\.git present=$clonedOk (ParserError signature=$parserErrorSeen); reporter's own 'cd ~/NitroAI; npm.cmd run dist:win' then exited $reportExit with installer present=$installerExists."
    exit 1
} else {
    Write-Host "BUGFIX_LAB_ABSENT"
    Write-Host "Evidence: clone step succeeded, reporter's two commands then exited 0, installer present."
    exit 0
}
