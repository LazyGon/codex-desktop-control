Set-StrictMode -Version Latest

function Enable-CodexCliRedirectForChildProcesses {
    [CmdletBinding()]
    param(
        [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexDesktopControl\bin')
    )

    $requiredFiles = @('codex.cmd', 'codex.ps1', 'redirect.json')
    foreach ($name in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $name) -PathType Leaf)) {
            return $false
        }
    }

    $normalizedInstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $existingEntries = @(
        ([string]$env:Path -split ';') |
            Where-Object {
                if (-not $_) {
                    return $false
                }
                $expanded = [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"'))
                try {
                    return [IO.Path]::GetFullPath($expanded).TrimEnd('\') -ine $normalizedInstallRoot
                }
                catch {
                    return $true
                }
            }
    )
    $env:Path = (@($InstallRoot) + $existingEntries) -join ';'
    return $true
}
