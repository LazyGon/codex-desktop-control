[CmdletBinding()]
param(
    [switch]$RemoveConfiguration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$stopScript = Join-Path $root 'Stop-DiscordBridge.ps1'
& $stopScript

$task = Get-ScheduledTask -TaskName 'Codex Discord Remote' -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName 'Codex Discord Remote' -Confirm:$false
}

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Remote'
if (Test-Path -LiteralPath $startMenuDir) {
    $resolved = [IO.Path]::GetFullPath($startMenuDir)
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
    if (-not $resolved.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove unexpected shortcut path: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

if ($RemoveConfiguration) {
    foreach ($path in @((Join-Path $root 'config\config.json'), (Join-Path $root 'config\token.dpapi'))) {
        $resolved = [IO.Path]::GetFullPath($path)
        if (-not $resolved.StartsWith([IO.Path]::GetFullPath((Join-Path $root 'config')), [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove unexpected configuration path: $resolved"
        }
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Force }
    }
}

[pscustomobject]@{
    Uninstalled = $true
    ConfigurationRemoved = [bool]$RemoveConfiguration
    RootPreserved = $root
}
