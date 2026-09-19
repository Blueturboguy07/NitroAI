param(
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [Parameter(Mandatory = $true)][string]$OracleTestFile
)

$ErrorActionPreference = "Stop"

Write-Host "== bugfix-lab oracle: nitroai-new-folder-button-noop =="
Write-Host "TargetDir: $TargetDir"

Set-Location $TargetDir

Write-Host "-- git rev-parse HEAD --"
git rev-parse HEAD

$destDir = Join-Path $TargetDir "src\pages"
$dest = Join-Path $destDir "__bugfix_lab_oracle__.test.tsx"
Copy-Item -Path $OracleTestFile -Destination $dest -Force
Write-Host "Installed oracle test at $dest"

Write-Host "-- npm ci --"
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host "BUGFIX_LAB_ERROR: npm ci failed with exit $LASTEXITCODE"
    exit 2
}

Write-Host "-- npx vitest run src/pages/__bugfix_lab_oracle__.test.tsx --"
npx vitest run "src/pages/__bugfix_lab_oracle__.test.tsx" --reporter=verbose
$testExit = $LASTEXITCODE

Write-Host "vitest exit code: $testExit"

if ($testExit -eq 0) {
    Write-Host "BUGFIX_LAB_ABSENT: clicking New Folder created and persisted a folder."
    exit 0
} else {
    Write-Host "BUGFIX_LAB_PRESENT: clicking New Folder did NOT create/persist a folder (test failed or modal never appeared)."
    exit 1
}
