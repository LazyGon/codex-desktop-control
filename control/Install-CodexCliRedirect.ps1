[CmdletBinding()]
param(
    [switch]$Uninstall,

    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexDesktopControl\bin'),

    [string]$OriginalCodexJavaScript = (
        Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\bin\codex.js'
    ),

    [switch]$SkipPathUpdate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$controlRoot = Split-Path -Parent $PSCommandPath
$dispatcher = Join-Path $controlRoot 'codex-default.mjs'
$manifestPath = Join-Path $InstallRoot 'redirect.json'
$ownedNames = @(
    'codex.cmd',
    'codex.ps1',
    'codex-original.cmd',
    'codex-original.ps1',
    'redirect.json'
)
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Normalize-PathEntry {
    param([Parameter(Mandatory)][string]$Value)
    return $Value.Trim().TrimEnd('\')
}

function Update-UserPath {
    param([Parameter(Mandatory)][bool]$Remove)

    if ($SkipPathUpdate) {
        return $false
    }

    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @(
        ([string]$current -split ';') |
            Where-Object { $_ -and (Normalize-PathEntry $_) -ine (Normalize-PathEntry $InstallRoot) }
    )
    if (-not $Remove) {
        $entries = @($InstallRoot) + $entries
    }
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
    return $true
}

function Notify-EnvironmentChanged {
    if ($SkipPathUpdate) {
        return
    }
    if (-not ('CodexCliRedirect.EnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexCliRedirect
{
    public static class EnvironmentBroadcast
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr window, uint message, IntPtr wParam, string lParam,
            uint flags, uint timeout, out IntPtr result);

        public static void Notify()
        {
            IntPtr result;
            SendMessageTimeout(new IntPtr(0xffff), 0x001A, IntPtr.Zero,
                "Environment", 0x0002, 5000, out result);
        }
    }
}
'@
    }
    [CodexCliRedirect.EnvironmentBroadcast]::Notify()
}

if ($Uninstall) {
    foreach ($name in $ownedNames) {
        $target = Join-Path $InstallRoot $name
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            Remove-Item -LiteralPath $target -Force
        }
    }
    $pathChanged = Update-UserPath -Remove $true
    Notify-EnvironmentChanged
    if ((Test-Path -LiteralPath $InstallRoot -PathType Container) -and
        @(Get-ChildItem -LiteralPath $InstallRoot -Force).Count -eq 0) {
        Remove-Item -LiteralPath $InstallRoot -Force
    }
    [pscustomobject]@{
        Uninstalled = $true
        InstallRoot = $InstallRoot
        UserPathChanged = $pathChanged
    }
    return
}

if (-not (Test-Path -LiteralPath $dispatcher -PathType Leaf)) {
    throw "Codex redirect dispatcher was not found: $dispatcher"
}
if (-not (Test-Path -LiteralPath $OriginalCodexJavaScript -PathType Leaf)) {
    throw "Original Codex CLI JavaScript entry point was not found: $OriginalCodexJavaScript"
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$manifest = [ordered]@{
    schemaVersion = 1
    repositoryRoot = Split-Path -Parent $controlRoot
    dispatcher = $dispatcher
    originalCodexJavaScript = $OriginalCodexJavaScript
    installedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
    $utf8
)

$escapedDispatcherForCmd = $dispatcher.Replace('%', '%%')
$escapedManifestForCmd = $manifestPath.Replace('%', '%%')
$escapedOriginalForCmd = $OriginalCodexJavaScript.Replace('%', '%%')
$cmd = @"
@echo off
set "CODEX_DESKTOP_CONTROL_REDIRECT_MANIFEST=$escapedManifestForCmd"
node "$escapedDispatcherForCmd" %*
exit /b %ERRORLEVEL%
"@
$originalCmd = @"
@echo off
node "$escapedOriginalForCmd" %*
exit /b %ERRORLEVEL%
"@

$dispatcherLiteral = $dispatcher.Replace("'", "''")
$manifestLiteral = $manifestPath.Replace("'", "''")
$originalLiteral = $OriginalCodexJavaScript.Replace("'", "''")
$powerShell = @"
`$env:CODEX_DESKTOP_CONTROL_REDIRECT_MANIFEST = '$manifestLiteral'
`$node = (Get-Command node.exe -ErrorAction Stop).Source
& `$node '$dispatcherLiteral' @args
exit `$LASTEXITCODE
"@
$originalPowerShell = @"
`$node = (Get-Command node.exe -ErrorAction Stop).Source
& `$node '$originalLiteral' @args
exit `$LASTEXITCODE
"@

[IO.File]::WriteAllText((Join-Path $InstallRoot 'codex.cmd'), $cmd, $utf8)
[IO.File]::WriteAllText((Join-Path $InstallRoot 'codex.ps1'), $powerShell, $utf8)
[IO.File]::WriteAllText((Join-Path $InstallRoot 'codex-original.cmd'), $originalCmd, $utf8)
[IO.File]::WriteAllText(
    (Join-Path $InstallRoot 'codex-original.ps1'),
    $originalPowerShell,
    $utf8
)

$pathChanged = Update-UserPath -Remove $false
Notify-EnvironmentChanged

[pscustomobject]@{
    Installed = $true
    InstallRoot = $InstallRoot
    Dispatcher = $dispatcher
    OriginalCodexJavaScript = $OriginalCodexJavaScript
    UserPathChanged = $pathChanged
    Note = 'Open a new terminal process before using the codex redirect.'
}
