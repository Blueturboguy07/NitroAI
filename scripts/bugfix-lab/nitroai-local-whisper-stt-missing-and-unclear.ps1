# bugfix-lab oracle runner for nitroai-local-whisper-stt-missing-and-unclear
#
# Reproduces on Windows what the reporters describe: a "Fully local" user
# with no OpenAI key clicks "Upload audio" on the Dashboard. Rather than
# driving the packaged Electron app's UI (unreliable/slow on a CI runner),
# this calls the exact function the UI calls -- LocalEngine.transcribe() --
# via the target checkout's own vitest, and reads back the real thrown
# message. Not a source grep: it runs the code.
#
# Usage: pwsh -File nitroai-local-whisper-stt-missing-and-unclear.ps1 -TargetDir <path>
param(
  [Parameter(Mandatory = $true)][string]$TargetDir
)
$ErrorActionPreference = "Stop"

$badBanner = "Local speech-to-text model not installed. Add an OpenAI key or install a local Whisper server."

$testDest = Join-Path $TargetDir "src/lib/engine/whisper-oracle.test.ts"
Copy-Item -Path "harness/scripts/bugfix-lab/whisper-oracle.test.ts" -Destination $testDest -Force
Write-Host "Injected oracle test at $testDest"

Push-Location $TargetDir
try {
    Write-Host "== npm ci =="
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "BUGFIX_LAB_ERROR: npm ci failed with exit $LASTEXITCODE"
        exit 2
    }

    if (Test-Path "bugfix-lab-oracle-output.txt") {
        Remove-Item "bugfix-lab-oracle-output.txt" -Force
    }

    Write-Host "== npx vitest run src/lib/engine/whisper-oracle.test.ts =="
    npx vitest run src/lib/engine/whisper-oracle.test.ts
    $vitestExit = $LASTEXITCODE
    if ($vitestExit -ne 0) {
        Write-Host "BUGFIX_LAB_ERROR: the oracle test harness itself failed to run (exit $vitestExit)"
        exit 2
    }

    if (-not (Test-Path "bugfix-lab-oracle-output.txt")) {
        Write-Host "BUGFIX_LAB_ERROR: no output file was produced"
        exit 2
    }

    $message = Get-Content "bugfix-lab-oracle-output.txt" -Raw
    $message = $message.Trim()
    Write-Host "OBSERVED MESSAGE: $message"

    if ($message -eq $badBanner) {
        Write-Host "BUGFIX_LAB_PRESENT"
        Pop-Location
        exit 1
    } else {
        Write-Host "BUGFIX_LAB_ABSENT"
        Pop-Location
        exit 0
    }
}
catch {
    Write-Host "BUGFIX_LAB_ERROR: $_"
    Pop-Location
    exit 2
}
