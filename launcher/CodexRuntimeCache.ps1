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
        [Parameter(Mandatory)][string]$BundledCommandRunnerExecutable,
        [Parameter(Mandatory)][string]$BundledSandboxServiceExecutable,
        [Parameter(Mandatory)][string]$BundledSandboxSetupExecutable,
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
    $cachedCommandRunnerExecutable = Join-Path $versionCacheRoot 'codex-command-runner.exe'
    $cachedSandboxServiceExecutable = Join-Path $versionCacheRoot 'codex-windows-sandbox-service.exe'
    $cachedSandboxSetupExecutable = Join-Path $versionCacheRoot 'codex-windows-sandbox-setup.exe'
    $serverHash = Copy-VerifiedCodexRuntimeFile `
        -SourcePath $BundledServerExecutable `
        -DestinationPath $cachedServerExecutable `
        -Description 'app-server executable'
    $codeModeHostHash = Copy-VerifiedCodexRuntimeFile `
        -SourcePath $BundledCodeModeHostExecutable `
        -DestinationPath $cachedCodeModeHostExecutable `
        -Description 'Code Mode host executable'
    $commandRunnerHash = Copy-VerifiedCodexRuntimeFile `
        -SourcePath $BundledCommandRunnerExecutable `
        -DestinationPath $cachedCommandRunnerExecutable `
        -Description 'command runner executable'
    $sandboxServiceHash = Copy-VerifiedCodexRuntimeFile `
        -SourcePath $BundledSandboxServiceExecutable `
        -DestinationPath $cachedSandboxServiceExecutable `
        -Description 'Windows sandbox service executable'
    $sandboxSetupHash = Copy-VerifiedCodexRuntimeFile `
        -SourcePath $BundledSandboxSetupExecutable `
        -DestinationPath $cachedSandboxSetupExecutable `
        -Description 'Windows sandbox setup executable'

    [pscustomobject]@{
        CacheRoot = [IO.Path]::GetFullPath($versionCacheRoot)
        ServerExecutable = [IO.Path]::GetFullPath($cachedServerExecutable)
        ServerSha256 = $serverHash
        CodeModeHostExecutable = [IO.Path]::GetFullPath($cachedCodeModeHostExecutable)
        CodeModeHostSha256 = $codeModeHostHash
        CommandRunnerExecutable = [IO.Path]::GetFullPath($cachedCommandRunnerExecutable)
        CommandRunnerSha256 = $commandRunnerHash
        SandboxServiceExecutable = [IO.Path]::GetFullPath($cachedSandboxServiceExecutable)
        SandboxServiceSha256 = $sandboxServiceHash
        SandboxSetupExecutable = [IO.Path]::GetFullPath($cachedSandboxSetupExecutable)
        SandboxSetupSha256 = $sandboxSetupHash
    }
}

function Save-CodexAppToolsCache {
    param(
        [Parameter(Mandatory)][string]$PluginRoot,
        [Parameter(Mandatory)][string]$VersionCacheRoot,
        [Parameter(Mandatory)][string]$PackageVersion,
        [Parameter(Mandatory)][string]$PackageFamilyName,
        [Parameter(Mandatory)][string]$ServerSha256
    )

    $manifest = @('.mcp.json', 'desktop-mcp.json') | Where-Object {
        Test-Path -LiteralPath (Join-Path $PluginRoot $_) -PathType Leaf
    } | Select-Object -First 1
    if (!$manifest) { return }
    $cache = Join-Path $VersionCacheRoot 'desktop-app-tools'
    New-Item -ItemType Directory -Path (Join-Path $cache 'scripts') -Force | Out-Null
    $files = [ordered]@{}
    foreach ($name in @($manifest, 'server.mjs', 'scripts/launch_codex_app_tools_mcp.cmd')) {
        $files[$name] = Copy-VerifiedCodexRuntimeFile -SourcePath (Join-Path $PluginRoot $name) `
            -DestinationPath (Join-Path $cache $name) -Description "Desktop app-tools $name"
    }
    $receipt = [ordered]@{
        packageVersion = $PackageVersion; packageFamilyName = $PackageFamilyName
        serverSha256 = $ServerSha256; manifest = $manifest; files = $files
    }
    $destination = Join-Path $cache 'runtime-bundle.json'
    $temporary = "$destination.$PID.tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-CodexPackageRuntime {
    param([Parameter(Mandatory)][object]$Package, [Parameter(Mandatory)][string]$CacheRoot)

    $runtimeCache = Initialize-CodexRuntimeCache `
        -BundledServerExecutable $package.BundledServerExecutable `
        -BundledCodeModeHostExecutable $package.BundledCodeModeHostExecutable `
        -BundledCommandRunnerExecutable $package.BundledCommandRunnerExecutable `
        -BundledSandboxServiceExecutable $package.BundledSandboxServiceExecutable `
        -BundledSandboxSetupExecutable $package.BundledSandboxSetupExecutable `
        -CacheRoot $CacheRoot `
        -PackageVersion $package.Version

    $resources = Split-Path -Parent $package.BundledServerExecutable
    try {
        Save-CodexAppToolsCache -PluginRoot (Join-Path $resources 'plugins\openai-bundled\plugins\codex-app-tools') `
            -VersionCacheRoot $runtimeCache.CacheRoot -PackageVersion $package.Version `
            -PackageFamilyName $package.PackageFamilyName -ServerSha256 $runtimeCache.ServerSha256
    } catch {
        Write-Warning 'The optional Desktop app-tools cache could not be refreshed.'
    }

    [pscustomobject]@{
        Version = $package.Version
        PackageFamilyName = $package.PackageFamilyName
        ApplicationUserModelId = $package.ApplicationUserModelId
        InstallLocation = $package.InstallLocation
        DesktopExecutable = $package.DesktopExecutable
        BundledServerExecutable = $package.BundledServerExecutable
        BundledCodeModeHostExecutable = $package.BundledCodeModeHostExecutable
        ServerExecutable = $runtimeCache.ServerExecutable
        ServerSha256 = $runtimeCache.ServerSha256
        CodeModeHostExecutable = $runtimeCache.CodeModeHostExecutable
        CodeModeHostSha256 = $runtimeCache.CodeModeHostSha256
    }
}
