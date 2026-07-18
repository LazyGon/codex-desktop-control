[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{15,22}$')]
    [string]$GuildId,

    [ValidatePattern('^\d{15,22}$')]
    [string]$ChannelId,

    [Security.SecureString]$BotToken
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $BotToken) { $BotToken = Read-Host 'Discord Bot Token' -AsSecureString }
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($BotToken)
$plainToken = $null
try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $env:DISCORD_BOT_TOKEN = $plainToken
    Push-Location $PSScriptRoot
    try {
        $arguments = @('scripts\diagnose-discord.mjs', $GuildId)
        if ($ChannelId) { $arguments += $ChannelId }
        $output = & node.exe @arguments 2>&1
        $exitCode = $LASTEXITCODE
        $text = ($output | Out-String).Trim()
        Write-Output $text
        $diagnosticPath = Join-Path $PSScriptRoot 'data\discord-diagnostic.json'
        [IO.File]::WriteAllText($diagnosticPath, "$text`n", [Text.UTF8Encoding]::new($false))
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
