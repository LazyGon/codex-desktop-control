[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8798,

    [switch]$RemoveConfiguration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$bridgeUninstaller = Join-Path $root 'discord-bridge\Uninstall-DiscordBridge.ps1'
$launcherInstaller = Join-Path $root 'launcher\Install-CodexSharedLauncher.ps1'

if (-not (Test-Path -LiteralPath $bridgeUninstaller -PathType Leaf)) {
    throw "Discord Bridge uninstaller was not found: $bridgeUninstaller"
}
if (-not (Test-Path -LiteralPath $launcherInstaller -PathType Leaf)) {
    throw "Shared launcher installer was not found: $launcherInstaller"
}

& $bridgeUninstaller -RemoveConfiguration:$RemoveConfiguration | Out-Host
& $launcherInstaller -Uninstall -Port $Port | Out-Host

[pscustomobject]@{
    Uninstalled = $true
    ConfigurationRemoved = [bool]$RemoveConfiguration
    RepositoryFilesPreserved = $true
    Note = 'A running Codex Desktop/shared app-server session is not terminated. Quit Desktop normally to finish runtime cleanup.'
}
