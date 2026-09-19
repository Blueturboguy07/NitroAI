# bugfix-lab oracle body for cluster: nitroai-windows-exe-smartscreen-block
#
# Reproduces the reporters' path: download the CURRENTLY PUBLISHED direct-download
# release asset for NitroAI on Windows (exactly what publik's /api/download/nitroai
# route 302s a real user to today: the GitHub release marked latest), onto a clean
# Windows runner with default settings, and inspect whether it carries a trusted
# Authenticode signature. Per the cluster's proposed oracle: reproduces if
# Get-AuthenticodeSignature Status is not 'Valid'. That absence of a trusted
# signature is what makes Windows SmartScreen show "isn't commonly downloaded" /
# "Windows protected your PC" for anyone opening it, which is exactly the block
# both reporters describe.
#
# Prints BUGFIX_LAB_PRESENT / BUGFIX_LAB_ABSENT and exits 1 / 0 accordingly.

$ErrorActionPreference = "Stop"

$AssetUrl = "https://github.com/Blueturboguy07/NitroAI/releases/download/v0.2.1/NitroAI-Setup-Windows.exe"
$OutFile = Join-Path $env:RUNNER_TEMP "NitroAI-Setup-Windows.exe"

Write-Output "Downloading: $AssetUrl"
Invoke-WebRequest -Uri $AssetUrl -OutFile $OutFile -UseBasicParsing

$fileInfo = Get-Item $OutFile
Write-Output "Downloaded file size: $($fileInfo.Length) bytes"

# Confirm this download carries Mark-of-the-Web the way a real user's browser
# download would (this is the zone data SmartScreen keys off of).
$zone = Get-Item -Path $OutFile -Stream Zone.Identifier -ErrorAction SilentlyContinue
if ($zone) {
    Write-Output "Zone.Identifier stream present (Mark-of-the-Web set):"
    Get-Content -Path $OutFile -Stream Zone.Identifier
} else {
    Write-Output "No Zone.Identifier stream (Invoke-WebRequest on this runner did not set MOTW; the"
    Write-Output "signature check below is independent of that and is the oracle's actual criterion)."
}

$sig = Get-AuthenticodeSignature -FilePath $OutFile
Write-Output "----"
Write-Output "Get-AuthenticodeSignature result:"
Write-Output "  Path:             $($sig.Path)"
Write-Output "  Status:           $($sig.Status)"
Write-Output "  StatusMessage:    $($sig.StatusMessage)"
if ($sig.SignerCertificate) {
    Write-Output "  SignerCertificate Subject: $($sig.SignerCertificate.Subject)"
} else {
    Write-Output "  SignerCertificate: (none)"
}
Write-Output "----"

# Also record signtool's view if available on the runner image, as corroborating
# evidence (not the pass/fail criterion — Get-AuthenticodeSignature is).
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($signtool) {
    Write-Output "signtool verify output:"
    & $signtool.Source verify /pa $OutFile
    Write-Output "signtool exit code: $LASTEXITCODE"
} else {
    Write-Output "signtool.exe not found on PATH (informational only, not required)."
}

if ($sig.Status -ne 'Valid') {
    Write-Output "BUGFIX_LAB_PRESENT"
    exit 1
} else {
    Write-Output "BUGFIX_LAB_ABSENT"
    exit 0
}
