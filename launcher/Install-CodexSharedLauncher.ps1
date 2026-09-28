[CmdletBinding()]
param(
    [switch]$Uninstall,

    [switch]$RefreshIconOnly,

    [ValidateRange(1024, 65535)]
    [int]$Port = 8798
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Uninstall -and $RefreshIconOnly) {
    throw 'Uninstall and RefreshIconOnly cannot be used together.'
}

$launcherRoot = Split-Path -Parent $PSCommandPath
$launcherScript = Join-Path $launcherRoot 'Start-CodexShared.ps1'
$launcherSource = Join-Path $launcherRoot 'CodexSharedLauncher.cs'
$launcherExecutable = Join-Path $launcherRoot 'CodexSharedLauncher.exe'
$launcherIcon = Join-Path $launcherRoot 'CodexSharedLauncher.ico'
$desktopPackageScript = Join-Path $launcherRoot 'CodexDesktopPackage.ps1'
$startMenuRoot = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $startMenuRoot 'Codex Shared Server.lnk'
$desktopShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Shared Server.lnk'
$taskbarRoot = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$webSocketUrl = "ws://127.0.0.1:$Port"

function Notify-EnvironmentChanged {
    if (-not ('CodexSharedLauncherInstaller.EnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexSharedLauncherInstaller
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
    [CodexSharedLauncherInstaller.EnvironmentBroadcast]::Notify()
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
    if (Test-Path -LiteralPath $desktopShortcutPath) {
        Remove-Item -LiteralPath $desktopShortcutPath -Force
    }
    $registeredUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
    if ($registeredUrl -eq $webSocketUrl) {
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
        Notify-EnvironmentChanged
    }
    [pscustomobject]@{
        Removed = $true
        ShortcutPath = $shortcutPath
        Note = 'Windows may require manual unpinning of an already pinned taskbar or Start item.'
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $launcherScript -PathType Leaf)) {
    throw "Launcher script was not found: $launcherScript"
}
if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) {
    throw "Launcher source was not found: $launcherSource"
}
if (-not (Test-Path -LiteralPath $desktopPackageScript -PathType Leaf)) {
    throw "Codex Desktop package helper was not found: $desktopPackageScript"
}
. $desktopPackageScript
. (Join-Path $launcherRoot 'CodexLauncherIcon.ps1')

# Record a verified runtime so a Start-menu/logon launch also works when
# Node.js was supplied by Codex's workspace runtime, not the user's PATH.
if (-not $RefreshIconOnly) {
    . (Join-Path $launcherRoot 'CodexNodeRuntime.ps1')
    $nodeStateRoot = Join-Path $launcherRoot 'state'
    $nodeExecutable = Initialize-CodexNodeRuntime -StateRoot $nodeStateRoot
    New-Item -ItemType Directory -Path $nodeStateRoot -Force | Out-Null
    $nodeRecordPath = Join-Path $nodeStateRoot 'node-runtime.json'
    $nodeRecordTemporaryPath = "$nodeRecordPath.$PID.tmp"
    $nodeRecord = [ordered]@{ schemaVersion = 1; nodeExecutable = $nodeExecutable }
    [IO.File]::WriteAllText($nodeRecordTemporaryPath, ($nodeRecord | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $nodeRecordTemporaryPath -Destination $nodeRecordPath -Force
}

$package = Get-CodexDesktopPackageInfo
$activeLaunchers = @(Get-Process -Name 'CodexSharedLauncher' -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $launcherExecutable
})
if ($activeLaunchers.Count -gt 0) {
    throw 'The launcher is briefly in use; retry after it finishes starting the shared Desktop.'
}
$iconInfo = Install-CodexLauncherIcon -InstallLocation $package.InstallLocation -LauncherRoot $launcherRoot

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The .NET Framework C# compiler was not found.'
}

$temporaryExecutable = Join-Path $launcherRoot "CodexSharedLauncher.$PID.tmp"
$compilerOutput = & $compiler /nologo /target:winexe /optimize+ "/win32icon:$launcherIcon" "/out:$temporaryExecutable" /reference:System.Windows.Forms.dll $launcherSource 2>&1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryExecutable -PathType Leaf)) {
    throw "Launcher compilation failed: $($compilerOutput -join [Environment]::NewLine)"
}
Move-Item -LiteralPath $temporaryExecutable -Destination $launcherExecutable -Force

$wsh = New-Object -ComObject WScript.Shell
$updatedShortcuts = @()
foreach ($destination in @($shortcutPath, $desktopShortcutPath)) {
    if ($RefreshIconOnly -and -not (Test-Path -LiteralPath $destination -PathType Leaf)) { continue }
    $shortcut = $wsh.CreateShortcut($destination)
    if ($RefreshIconOnly) {
        if ($shortcut.TargetPath -ne $launcherExecutable) { continue }
    }
    else {
        $shortcut.TargetPath = $launcherExecutable
        $shortcut.Arguments = ''
        $shortcut.WorkingDirectory = $launcherRoot
        $shortcut.Description = 'Start Codex Desktop on a shared local app-server'
    }
    $shortcut.IconLocation = "$($iconInfo.ShortcutIconPath),0"
    $shortcut.Save()
    $updatedShortcuts += $destination
}

$pinnedTaskbarShortcut = Join-Path $taskbarRoot (Split-Path -Leaf $shortcutPath)
$taskbarShortcutUpdated = $false
if (Test-Path -LiteralPath $pinnedTaskbarShortcut -PathType Leaf) {
    $pinnedShortcut = $wsh.CreateShortcut($pinnedTaskbarShortcut)
    if (-not $RefreshIconOnly) {
        $pinnedShortcut.TargetPath = $launcherExecutable
        $pinnedShortcut.Arguments = ''
        $pinnedShortcut.WorkingDirectory = $launcherRoot
        $pinnedShortcut.Description = 'Start Codex Desktop on a shared local app-server'
    }
    if ($pinnedShortcut.TargetPath -eq $launcherExecutable) {
        $pinnedShortcut.IconLocation = "$($iconInfo.ShortcutIconPath),0"
        $pinnedShortcut.Save()
        $taskbarShortcutUpdated = $true
        $updatedShortcuts += $pinnedTaskbarShortcut
    }
}
Notify-CodexLauncherIconChanged -Paths (@($launcherExecutable, $iconInfo.ShortcutIconPath) + $updatedShortcuts)

if ($RefreshIconOnly) {
    [pscustomobject]@{
        IconRefreshed = $true
        IconPath = $iconInfo.ShortcutIconPath
        FrameSizes = $iconInfo.FrameSizes
        UpdatedShortcuts = $updatedShortcuts
        RuntimeUnchanged = $true
    }
    exit 0
}

$registeredUrl = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
$runtimeStateCandidates = @(
    (Join-Path $launcherRoot 'state\current.json')
)
$activeSharedSession = $false
foreach ($runtimeStatePath in $runtimeStateCandidates) {
    if (-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)) {
        continue
    }
    try {
        $runtimeState = Get-Content -LiteralPath $runtimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($runtimeState.websocketUrl -eq $webSocketUrl -and $runtimeState.desktopConnectionVerified -eq $true) {
            $activeSharedSession = $true
            break
        }
    }
    catch {
        # A stale or partial state file must not block installation.
    }
}
if ($registeredUrl -eq $webSocketUrl -and -not $activeSharedSession) {
    [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
    Notify-EnvironmentChanged
}

$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace((Split-Path -Parent $shortcutPath))
$item = $folder.ParseName((Split-Path -Leaf $shortcutPath))
$availableVerbs = @()
$taskbarPinRequested = $false
$startPinRequested = $false

if ($null -ne $item) {
    $verbs = @($item.Verbs())
    $availableVerbs = @($verbs | ForEach-Object { ($_.Name -replace '&', '').Trim() } | Where-Object { $_ })

    try {
        $item.InvokeVerb('taskbarpin')
        $taskbarPinRequested = $true
        Start-Sleep -Seconds 2
    }
    catch {
        $taskbarPinRequested = $false
    }

    try {
        $item.InvokeVerb('startpin')
        $startPinRequested = $true
        Start-Sleep -Seconds 2
    }
    catch {
        $startPinRequested = $false
    }

    $refreshedVerbs = @($item.Verbs())
    $localizedStartPinVerb = $refreshedVerbs | Where-Object {
        $name = ($_.Name -replace '&', '').Trim()
        $name -match '^(Pin to Start|スタート\s*にピン留めする)'
    } | Select-Object -First 1
    if ($null -ne $localizedStartPinVerb) {
        try {
            $localizedStartPinVerb.DoIt()
            $startPinRequested = $true
            Start-Sleep -Seconds 2
        }
        catch {
            $startPinRequested = $false
        }
    }
}

$taskbarShortcutDetected = Test-Path -LiteralPath $pinnedTaskbarShortcut -PathType Leaf
$verificationFolder = $shell.Namespace((Split-Path -Parent $shortcutPath))
$verificationItem = $verificationFolder.ParseName((Split-Path -Leaf $shortcutPath))
$verificationVerbNames = @(
    $verificationItem.Verbs() |
        ForEach-Object { ($_.Name -replace '&', '').Trim() } |
        Where-Object { $_ }
)
$startPinDetected = @(
    $verificationVerbNames | Where-Object {
        $_ -match '^(Unpin from Start|スタート\s*からピン留めを外す)'
    }
).Count -gt 0

[pscustomobject]@{
    Installed = Test-Path -LiteralPath $shortcutPath -PathType Leaf
    ShortcutPath = $shortcutPath
    DesktopShortcutPath = $desktopShortcutPath
    TargetPath = $launcherExecutable
    LauncherScript = $launcherScript
    IconPath = $launcherIcon
    EnvironmentMode = 'Transient per launcher run'
    RegisteredWebSocketUrlAfterInstall = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
    TaskbarPinRequested = $taskbarPinRequested
    TaskbarShortcutDetected = $taskbarShortcutDetected
    TaskbarShortcutUpdated = $taskbarShortcutUpdated
    StartPinRequested = $startPinRequested
    StartPinDetected = $startPinDetected
    AvailableShellVerbs = $availableVerbs -join '; '
}
