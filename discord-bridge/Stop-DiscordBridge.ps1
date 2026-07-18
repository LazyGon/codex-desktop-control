[CmdletBinding()]
param(
    [int]$TimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$dataDir = Join-Path $root 'data'
$lockPath = Join-Path $dataDir 'bridge.lock'
$stopPath = Join-Path $dataDir 'stop.request'

if (-not (Test-Path -LiteralPath $lockPath)) {
    Write-Output 'Codex Discord Bridge is not running.'
    exit 0
}

$pidText = (Get-Content -Raw -LiteralPath $lockPath).Trim()
$temporary = "$stopPath.$PID.tmp"
[IO.File]::WriteAllText($temporary, "requestedAt=$([DateTimeOffset]::Now.ToString('o'))`nrequesterPid=$PID`n", [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $stopPath -Force

$deadline = [DateTimeOffset]::Now.AddSeconds($TimeoutSeconds)
while ((Test-Path -LiteralPath $lockPath) -and [DateTimeOffset]::Now -lt $deadline) {
    Start-Sleep -Milliseconds 250
}

if (Test-Path -LiteralPath $lockPath) {
    throw "Graceful stop timed out after $TimeoutSeconds seconds. PID was $pidText. No process kill was attempted."
}

[console]::Beep(880, 140)
Start-Sleep -Milliseconds 70
[console]::Beep(660, 180)
Write-Output "Codex Discord Bridge stopped gracefully (PID $pidText)."
