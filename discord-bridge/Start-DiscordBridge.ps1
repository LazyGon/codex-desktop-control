[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
$tokenPath = Join-Path $root 'config\token.dpapi'
$lockPath = Join-Path $root 'data\bridge.lock'
$node = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Configuration is missing: $configPath"
}
if (-not (Test-Path -LiteralPath $tokenPath)) {
    throw "Protected Discord token is missing: $tokenPath"
}

if (Test-Path -LiteralPath $lockPath) {
    $existingPid = 0
    [void][int]::TryParse((Get-Content -Raw -LiteralPath $lockPath).Trim(), [ref]$existingPid)
    if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
        Write-Output "Codex Discord Bridge is already running as PID $existingPid."
        exit 0
    }
}

$encrypted = Get-Content -Raw -Encoding UTF8 -LiteralPath $tokenPath
$secureToken = ConvertTo-SecureString $encrypted.Trim()
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$plainToken = $null

try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $env:DISCORD_BOT_TOKEN = $plainToken
    Push-Location $root
    try {
        & $node 'src\index.mjs'
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
    $plainToken = $null
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

exit $exitCode
