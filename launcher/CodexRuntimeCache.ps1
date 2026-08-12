Set-StrictMode -Version Latest

function Copy-VerifiedCodexRuntimeFile {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$DestinationPath,
        [Parameter(Mandatory)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "$Description was not found: $SourcePath"
    }

    $sourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
    $cacheIsCurrent = $false
    if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        $cachedHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash
        $cacheIsCurrent = $cachedHash -eq $sourceHash
    }

    if (-not $cacheIsCurrent) {
        $temporaryPath = "$DestinationPath.$PID.tmp"
        try {
            Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath -Force
            $temporaryHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash
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
