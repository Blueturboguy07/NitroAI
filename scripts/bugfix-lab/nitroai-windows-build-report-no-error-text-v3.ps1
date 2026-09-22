# Oracle v3 for cluster nitroai-windows-build-report-no-error-text.
#
# FIX round 1 (2026-09-21). v2 (still present alongside this file, unmodified,
# for VERIFY lens A to toggle against by commit) hardcoded the "clone" step's
# PRE-FIX PowerShell literal, byte-for-byte from publik/lib/guides/nitroai.ts
# on origin/main @ 44b7353/0c7ab2e — the unbranched POSIX `if [ ! -d … ]; then
# … fi` form with no isMac ternary, confirmed to ParserError 3/3 on
# windows-latest CI (runs 35672644816/35672702583/35672736209).
#
# The region for this cluster (REGION.json) lives in publik, a DIFFERENT repo
# than the one this CI oracle runs in (NitroAI). The oracle script therefore
# cannot "read" a publik fix at CI runtime without also checking out publik —
# by design (see LAB.md's guide-text pattern: "put the .ps1 + workflow in the
# app repo the guide installs"), this campaign observes a guide-text fix by
# updating the hardcoded command literal here to match what the FIXED guide
# renders, then letting VERIFY toggle between the pre-fix commit (this file
# absent / v2's literal) and the fix commit (this file, with the post-fix
# literal) in THIS repo. The literal below is not hand-typed: it was
# mechanically extracted by rendering the guide after editing
# publik/lib/guides/nitroai.ts on branch fix/nitroai-windows-build-report-no-error-text:
#   cd $WORK/publik && npx tsx ~/bugfix-lab/bin/render-guide.mts nitroai windows --json
#   -> clone step command: 'cd ~\nif (-not (Test-Path NitroAI/.git)) {\ngit clone https://github.com/Blueturboguy07/NitroAI.git\n}'
# which matches the shape of the already-open sibling PR
# (Blueturboguy07/publik#3, commit ba7abe6, break 4eebe542) for this exact line.
#
# SECOND correction made this round, found empirically (not assumed): v2 ran
# ONLY the reporter's own two literal lines ("cd ~/NitroAI",
# "npm.cmd run dist:win") straight after the clone step, with no install step.
# Locally (brew pwsh + a real NitroAI clone at the pinned sha, same npm/node
# semantics as windows-latest — verified separately, see fix-log.md):
#   git clone + checkout <pinned sha>, then `npm run dist:win` with NO prior
#   `npm ci` -> fails immediately, "tsc: command not found" (Windows:
#   "'tsc' is not recognized..."), because node_modules was never installed.
#   The SAME clone + `npm ci` + `npm run build` -> succeeds cleanly.
# The guide's own documented Windows session has a dedicated "dependencies"
# step (id "dependencies", command `npm.cmd ci`) between "pin-source" and
# "package" (`npm.cmd run dist:win`) — the report's terse two-line body
# almost certainly omits it as an assumed/forgotten step, not a claim that no
# install ever happened. Running v2's literal two commands after a NOW-FIXED
# clone would therefore still return PRESENT for an UNRELATED reason (missing
# devDependencies), confounding this cluster's actual region (the clone
# step's ParserError) with an artifact of an incomplete reproduction script.
# v3 adds that documented "dependencies" step, sourced verbatim from the
# guide file, before the reporter's own final command — so PRESENT/ABSENT
# here isolates the clone-step fix under test, matching "the documented
# Windows guide session" the cluster's own oracle spec calls for.
#
# Pass/fail LOGIC is otherwise UNCHANGED from v2 — same presence bar (clone
# leaves a real NitroAI\.git tree AND install succeeds AND the reporter's own
# final command succeeds AND the installer exists). Only the sourced clone
# command TEXT and the added install step changed.
#
# PRESENT (exit 1) = the clone step does not leave a real NitroAI/.git working
#   tree AND/OR dependencies fail to install AND/OR the reporter's own final
#   command then fails.
# ABSENT (exit 0) = NitroAI got cloned, dependencies installed, and
#   dist:win completed with an installer.
# exit 2 = oracle itself could not run.

$PINNED_SHA = "4df4aaee787ee09b9b5062119e37b4a9816fa808"
Set-Location $env:USERPROFILE
if (Test-Path "$env:USERPROFILE\NitroAI") {
    Remove-Item -Recurse -Force "$env:USERPROFILE\NitroAI"
}

Write-Host "== STEP: clone (guide step id 'clone', windows branch, POST-FIX command as rendered from the fix/nitroai-windows-build-report-no-error-text publik branch) =="
# Literal command text, byte-for-byte from render-guide.mts against the fixed
# lib/guides/nitroai.ts nitroSteps() "clone" step, windows branch (isMac ternary).
$cloneCmd = "cd ~`nif (-not (Test-Path NitroAI/.git)) {`ngit clone https://github.com/Blueturboguy07/NitroAI.git`n}"
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
Write-Host "== STEP: guide's own 'dependencies' step (id 'dependencies', windows command 'npm.cmd ci'), run only if the clone left a real working tree =="
$depOk = $true
$depExit = 0
if ($clonedOk) {
    $depCmd = "cd ~/NitroAI`nnpm.cmd ci"
    Write-Host "--- command text ---"
    Write-Host $depCmd
    Write-Host "--- output ---"
    $depOut = & pwsh -NoProfile -Command $depCmd 2>&1 | Out-String
    Write-Host $depOut
    $depExit = $LASTEXITCODE
    $depOk = ($depExit -eq 0)
    Write-Host "dependencies step exit code: $depExit"
} else {
    Write-Host "(skipped: no NitroAI/.git to install into)"
    $depOk = $false
}

Write-Host ""
Write-Host "== STEP: reporter's own final command (report eb1f2a11), run in a fresh PowerShell process =="
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

if (-not $clonedOk -or -not $depOk -or $reportExit -ne 0 -or -not $installerExists) {
    Write-Host "BUGFIX_LAB_PRESENT"
    Write-Host "Evidence: clone-step left NitroAI\.git present=$clonedOk (ParserError signature=$parserErrorSeen); dependencies step exit=$depExit (ok=$depOk); reporter's own 'cd ~/NitroAI; npm.cmd run dist:win' then exited $reportExit with installer present=$installerExists."
    exit 1
} else {
    Write-Host "BUGFIX_LAB_ABSENT"
    Write-Host "Evidence: clone step succeeded, dependencies installed cleanly, reporter's final command then exited 0, installer present."
    exit 0
}
