function Get-CodexIconInfo {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 6 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or
        [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
        throw "Invalid ICO header: $Path"
    }
    $count = [BitConverter]::ToUInt16($bytes, 4)
    $directoryEnd = 6 + 16 * $count
    if ($count -eq 0 -or $directoryEnd -gt $bytes.Length) {
        throw "Invalid ICO directory: $Path"
    }
    $frames = @(for ($index = 0; $index -lt $count; $index++) {
        $entry = 6 + 16 * $index
        $width = [int]$bytes[$entry]
        $height = [int]$bytes[$entry + 1]
        if ($width -eq 0) { $width = 256 }
        if ($height -eq 0) { $height = 256 }
        $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
        if ($length -eq 0 -or $offset -lt $directoryEnd -or
            ([long]$offset + $length) -gt $bytes.Length) {
            throw "Invalid ICO frame: $Path"
        }
        [pscustomobject]@{ Width = $width; Height = $height }
    })
    [pscustomobject]@{ Path = $Path; Frames = $frames }
}

function Install-CodexLauncherIcon {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$InstallLocation,
        [Parameter(Mandatory)][string]$LauncherRoot
    )

    # ExtractAssociatedIcon keeps only one small frame. Preserve the packaged
    # ICO verbatim so Windows can select the right size at every display scale.
    $source = $null
    $info = $null
    foreach ($name in @('icon-chatgpt.ico', 'chatgpt-app-light.ico', 'chatgpt-app-dark.ico')) {
        $candidate = Join-Path $InstallLocation "app\resources\$name"
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $candidateInfo = Get-CodexIconInfo -Path $candidate
        $large = @($candidateInfo.Frames | Where-Object { $_.Width -eq 256 -and $_.Height -eq 256 })
        $small = @($candidateInfo.Frames | Where-Object { $_.Width -eq 32 -and $_.Height -eq 32 })
        if ($large.Count -gt 0 -and $small.Count -gt 0) {
            $source = $candidate
            $info = $candidateInfo
            break
        }
    }
    if ($null -eq $source) {
        throw 'No packaged multi-resolution Codex icon (32px and 256px) was found.'
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($source)))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
    $iconRoot = Join-Path $LauncherRoot 'state\icons'
    New-Item -ItemType Directory -Path $iconRoot -Force | Out-Null
    # A content-specific path bypasses Explorer's cached low-resolution icon
    # without deleting the user's icon cache or restarting Explorer.
    $shortcutIcon = Join-Path $iconRoot "CodexSharedLauncher-$hash.ico"
    Copy-Item -LiteralPath $source -Destination $shortcutIcon -Force
    $iconPath = Join-Path $LauncherRoot 'CodexSharedLauncher.ico'
    Copy-Item -LiteralPath $source -Destination $iconPath -Force
    [pscustomobject]@{
        SourcePath = $source
        IconPath = $iconPath
        ShortcutIconPath = $shortcutIcon
        FrameSizes = @($info.Frames | ForEach-Object { "$($_.Width)x$($_.Height)" })
    }
}

function Notify-CodexLauncherIconChanged {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]]$Paths)

    if (-not ('CodexSharedLauncherInstaller.IconNotification' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace CodexSharedLauncherInstaller {
    public static class IconNotification {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern void SHChangeNotify(uint eventId, uint flags, string item1, string item2);
        public static void Notify(string path) {
            SHChangeNotify(0x00002000, 0x0005, path, null); // UPDATEITEM / PATHW
        }
    }
}
'@
    }
    foreach ($path in $Paths) {
        [CodexSharedLauncherInstaller.IconNotification]::Notify($path)
    }
}
