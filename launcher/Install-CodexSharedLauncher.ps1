[CmdletBinding()]
param(
    [switch]$Uninstall,

    [ValidateRange(1024, 65535)]
    [int]$Port = 8798
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherRoot = Split-Path -Parent $PSCommandPath
$launcherScript = Join-Path $launcherRoot 'Start-CodexShared.ps1'
$launcherSource = Join-Path $launcherRoot 'CodexSharedLauncher.cs'
$launcherExecutable = Join-Path $launcherRoot 'CodexSharedLauncher.exe'
$launcherIcon = Join-Path $launcherRoot 'CodexSharedLauncher.ico'
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

$package = Get-AppxPackage -Name 'OpenAI.Codex' |
    Sort-Object { [version]$_.Version } -Descending |
    Select-Object -First 1
if ($null -eq $package) {
    throw 'OpenAI.Codex is not installed for the current Windows user.'
}

$desktopExecutable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
    throw "Desktop executable was not found: $desktopExecutable"
}

Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($desktopExecutable)
if ($null -eq $icon) {
    throw "Unable to extract the Codex icon from: $desktopExecutable"
}
$iconStream = [IO.File]::Open($launcherIcon, [IO.FileMode]::Create)
try {
    $icon.Save($iconStream)
}
finally {
    $iconStream.Dispose()
    $icon.Dispose()
}

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The .NET Framework C# compiler was not found.'
}

$compilerOutput = & $compiler /nologo /target:winexe /optimize+ "/win32icon:$launcherIcon" "/out:$launcherExecutable" /reference:System.Windows.Forms.dll $launcherSource 2>&1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) {
    throw "Launcher compilation failed: $($compilerOutput -join [Environment]::NewLine)"
}

$wsh = New-Object -ComObject WScript.Shell
foreach ($destination in @($shortcutPath, $desktopShortcutPath)) {
    $shortcut = $wsh.CreateShortcut($destination)
    $shortcut.TargetPath = $launcherExecutable
    $shortcut.Arguments = ''
    $shortcut.WorkingDirectory = $launcherRoot
    $shortcut.IconLocation = "$launcherExecutable,0"
    $shortcut.Description = 'Start Codex Desktop on a shared local app-server'
    $shortcut.Save()
}

$pinnedTaskbarShortcut = Join-Path $taskbarRoot (Split-Path -Leaf $shortcutPath)
$taskbarShortcutUpdated = $false
if (Test-Path -LiteralPath $pinnedTaskbarShortcut -PathType Leaf) {
    $pinnedShortcut = $wsh.CreateShortcut($pinnedTaskbarShortcut)
    $pinnedShortcut.TargetPath = $launcherExecutable
    $pinnedShortcut.Arguments = ''
    $pinnedShortcut.WorkingDirectory = $launcherRoot
    $pinnedShortcut.IconLocation = "$launcherExecutable,0"
    $pinnedShortcut.Description = 'Start Codex Desktop on a shared local app-server'
    $pinnedShortcut.Save()
    $taskbarShortcutUpdated = $true
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
