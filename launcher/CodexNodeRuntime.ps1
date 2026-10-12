function Initialize-CodexWindowsProcessEnvironment {
    [CmdletBinding()]
    param()

    # Sparse agent/REPL environments can omit these Windows variables. Windows
    # PowerShell then recognizes only .CPL and treats node.exe as a document.
    # Recover only this process and its future children; never write the registry.
    $nextPathext = [string]$env:PATHEXT
    $pathextChanged = -not (($nextPathext -split ';').Trim() -contains '.EXE')
    if ($pathextChanged) {
        $nextPathext = $null
        foreach ($scope in @('User', 'Machine')) {
            $saved = [Environment]::GetEnvironmentVariable('PATHEXT', $scope)
            if (-not [string]::IsNullOrWhiteSpace($saved) -and
                (($saved -split ';').Trim() -contains '.EXE')) {
                $nextPathext = $saved
                break
            }
        }
        if (-not $nextPathext) {
            throw 'No saved Windows PATHEXT includes .EXE. No registry setting was changed.'
        }
    }

    $nextComSpec = [string]$env:ComSpec
    $comSpecChanged = [string]::IsNullOrWhiteSpace($nextComSpec) -or
        -not [IO.Path]::IsPathRooted($nextComSpec) -or -not [IO.File]::Exists($nextComSpec)
    if ($comSpecChanged) {
        $nextComSpec = $null
        foreach ($scope in @('User', 'Machine')) {
            $saved = [Environment]::GetEnvironmentVariable('ComSpec', $scope)
            if ([string]::IsNullOrWhiteSpace($saved)) { continue }
            $saved = [Environment]::ExpandEnvironmentVariables($saved)
            if ([IO.Path]::IsPathRooted($saved) -and [IO.File]::Exists($saved)) {
                $nextComSpec = $saved
                break
            }
        }
        if (-not $nextComSpec) {
            throw 'No saved Windows ComSpec points to an existing executable. No registry setting was changed.'
        }
    }

    # Validate both replacements before applying either. Valid explicit values
    # (including custom PATHEXT entries) stay unchanged.
    if ($pathextChanged) { $env:PATHEXT = $nextPathext }
    if ($comSpecChanged) { $env:ComSpec = $nextComSpec }
    return [pscustomobject]@{ PathextChanged = $pathextChanged; ComSpecChanged = $comSpecChanged }
}

function Get-CodexNodeExecutable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [AllowEmptyString()][string]$SearchPath = $env:PATH
    )
    foreach ($directory in ($SearchPath -split [IO.Path]::PathSeparator)) {
        $directory = $directory.Trim().Trim('"')
        if (-not $directory) { continue }
        try { $candidate = Join-Path $directory 'node.exe' } catch { continue }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    $recordPath = Join-Path $StateRoot 'node-runtime.json'
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        $candidate = [string]$record.nodeExecutable
        if ($record.schemaVersion -ne 1 -or -not [IO.Path]::IsPathRooted($candidate) -or
            [IO.Path]::GetFileName($candidate) -ine 'node.exe' -or
            -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw 'The recorded Node.js runtime is invalid or missing. Rerun the launcher installer with Node.js available.'
        }
        return [IO.Path]::GetFullPath($candidate)
    }
    throw 'Node.js is not on PATH and no installed runtime was recorded. Rerun the launcher installer with Node.js 22 or newer available.'
}

function Get-CodexBundledPowerShellExecutable {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$NodeExecutable)
    # Only infer a sibling inside the bundled dependencies/node/bin layout.
    $nodeBin = Split-Path -Parent $NodeExecutable
    $nodeRoot = Split-Path -Parent $nodeBin
    $dependencies = Split-Path -Parent $nodeRoot
    if ([IO.Path]::GetFileName($nodeBin) -ine 'bin' -or
        [IO.Path]::GetFileName($nodeRoot) -ine 'node' -or
        [IO.Path]::GetFileName($dependencies) -ine 'dependencies') { return $null }
    $candidate = Join-Path $dependencies 'native/powershell/pwsh.exe'
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    # A child Windows PowerShell can inherit a PowerShell 7 module search path.
    # Load this host's own signed-runtime verifier, without changing module paths
    # or treating module-load failure as permission to skip signature checks.
    $securityModule = Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'
    Import-Module -Name $securityModule -ErrorAction Stop
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $candidate
    $product = [Diagnostics.FileVersionInfo]::GetVersionInfo($candidate).ProductName
    if ($signature.Status -ne 'Valid' -or
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(?:^|,)\s*CN=Microsoft Corporation(?:,|$)' -or
        $product -notlike 'PowerShell*') {
        throw 'The bundled PowerShell executable is not a verified Microsoft PowerShell binary.'
    }
    return [IO.Path]::GetFullPath($candidate)
}

function Initialize-CodexNodeRuntime {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)
    $null = Initialize-CodexWindowsProcessEnvironment
    $nodeExecutable = Get-CodexNodeExecutable -StateRoot $StateRoot
    $nodeVersion = (& $nodeExecutable --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Codex Desktop Control requires Node.js 22 or newer.'
    }
    $nodeDirectory = Split-Path -Parent $nodeExecutable
    $powerShellExecutable = Get-CodexBundledPowerShellExecutable -NodeExecutable $nodeExecutable
    $prefix = @($nodeDirectory)
    if ($powerShellExecutable) { $prefix += Split-Path -Parent $powerShellExecutable }
    # Children resolve the real executable before WindowsApps execution aliases.
    # Only this launcher's process environment changes; running servers keep theirs.
    $env:PATH = ($prefix -join [IO.Path]::PathSeparator) + [IO.Path]::PathSeparator + $env:PATH
    return $nodeExecutable
}
