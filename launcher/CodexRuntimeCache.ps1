Set-StrictMode -Version Latest

function Get-CodexFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "File was not found for SHA-256 calculation: $Path"
    }
    $stream = [IO.File]::Open(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Copy-VerifiedCodexRuntimeFile {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$DestinationPath,
        [Parameter(Mandatory)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "$Description was not found: $SourcePath"
    }

    $sourceHash = Get-CodexFileSha256 -Path $SourcePath
    $cacheIsCurrent = $false
    if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        $cachedHash = Get-CodexFileSha256 -Path $DestinationPath
        $cacheIsCurrent = $cachedHash -eq $sourceHash
    }

    if (-not $cacheIsCurrent) {
        $temporaryPath = "$DestinationPath.$PID.tmp"
        try {
            Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath -Force
            $temporaryHash = Get-CodexFileSha256 -Path $temporaryPath
            if ($temporaryHash -ne $sourceHash) {
                throw "The cached $Description hash does not match the Desktop package."
            }
            Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
    }

    $sourceHash
}

function Initialize-CodexRuntimeCache {
    param(
        [Parameter(Mandatory)][string]$BundledServerExecutable,
        [Parameter(Mandatory)][string]$BundledCodeModeHostExecutable,
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)]
        [ValidatePattern('^[0-9A-Za-z._-]+$')]
        [string]$PackageVersion
    )

    $versionCacheRoot = Join-Path $CacheRoot $PackageVersion
    New-Item -ItemType Directory -Path $versionCacheRoot -Force | Out-Null

    # app-server resolves its local Code Mode host beside its own executable
    # using this exact companion filename. Keep each package version isolated so
    # an app update cannot replace a companion used by a still-running server.
    $cachedServerExecutable = Join-Path $versionCacheRoot 'codex.exe'
    $cachedCodeModeHostExecutable = Join-Path $versionCacheRoot 'codex-code-mode-host.exe'
    $serverHash = Copy-VerifiedCodexRuntimeFile `
        -SourcePath $BundledServerExecutable `
        -DestinationPath $cachedServerExecutable `
        -Description 'app-server executable'
    $codeModeHostHash = Copy-VerifiedCodexRuntimeFile `
        -SourcePath $BundledCodeModeHostExecutable `
        -DestinationPath $cachedCodeModeHostExecutable `
        -Description 'Code Mode host executable'

    [pscustomobject]@{
        CacheRoot = [IO.Path]::GetFullPath($versionCacheRoot)
        ServerExecutable = [IO.Path]::GetFullPath($cachedServerExecutable)
        ServerSha256 = $serverHash
        CodeModeHostExecutable = [IO.Path]::GetFullPath($cachedCodeModeHostExecutable)
        CodeModeHostSha256 = $codeModeHostHash
    }
}
