[CmdletBinding(PositionalBinding = $false)]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ControlArguments)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bridgeRoot = Join-Path $root 'discord-bridge'
$tokenPath = Join-Path $bridgeRoot 'config\token.dpapi'
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw 'This PC has no protected Bot credential for authenticated peer control.'
}
. (Join-Path $root 'launcher\CodexNodeRuntime.ps1')
. (Join-Path $bridgeRoot 'DiscordBotToken.ps1')
$node = Initialize-CodexNodeRuntime -StateRoot (Join-Path $root 'launcher\state')
$encrypted = Get-Content -LiteralPath $tokenPath -Raw -Encoding UTF8
$secureToken = ConvertTo-SecureString $encrypted.Trim()
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$plainToken = $null
try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $env:DISCORD_BOT_TOKEN = $plainToken
    & $node (Join-Path $PSScriptRoot 'codex-peer.mjs') @ControlArguments
    $exitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
    $plainToken = $null
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secureToken.Dispose()
}
exit $exitCode
