param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexSystemErrorRecovery'),
    [string]$NodePath = (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'),
    [string]$PythonwPath = (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/pythonw.exe'),
    [string[]]$ExcludedThreadIds = @(),
    [switch]$CheckOnly,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
if ([Net.Dns]::GetHostName() -ine 'LAPTOP-728OIQQK') { throw 'This deployment is for the verified OMEN only.' }
$controlRoot = Split-Path -Parent $PSScriptRoot
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$sourceManifestPath = Join-Path $PackageRoot 'package-manifest.json'
$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$packagePrefix = $PackageRoot.TrimEnd('\') + '\'
foreach ($entry in $sourceManifest.files) {
    $sourceFile = [IO.Path]::GetFullPath((Join-Path $PackageRoot $entry.path))
    if (-not $sourceFile.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escapes its root.' }
    if ((Get-Item -LiteralPath $sourceFile).Length -ne $entry.byteLength -or
        (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash -ine $entry.sha256) { throw ('Unverified package file: ' + $entry.path) }
}
# Only the exact supplied, inspected package can be derived here. This is a
# content pin, not a signature or permission to import another PC's state.
if ((Get-FileHash -LiteralPath $sourceManifestPath -Algorithm SHA256).Hash -ine '05E416ACACDBFA5AA56B961397A1CBD7595D9AA2A62193BA80DB2BBAFFAF5BD2') {
    throw 'Unexpected source package manifest.'
}
if (-not $CheckOnly) {
    if (Get-ScheduledTask -TaskName 'Codex System Error Recovery' -ErrorAction SilentlyContinue) { throw 'Recovery task already exists; inspect it without replacement.' }
    if (Test-Path -LiteralPath $InstallRoot) { throw 'InstallRoot already exists; preserve its journals.' }
}
$stage = Join-Path $controlRoot ('state/omen-recovery-deployment-' + [guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $stage
Get-ChildItem -LiteralPath $PackageRoot | Copy-Item -Destination $stage -Recurse
function Replace-Exact([string]$RelativePath, [string]$Old, [string]$New) {
    $file = Join-Path $stage $RelativePath
    $text = [IO.File]::ReadAllText($file)
    if ([regex]::Matches($text, [regex]::Escape($Old)).Count -ne 1) { throw ('Overlay source differs: ' + $RelativePath) }
    [IO.File]::WriteAllText($file, $text.Replace($Old, $New), [Text.UTF8Encoding]::new($false))
}
# Owner AGENTS section 9: optional source defaults are not evidence-backed limits.
Replace-Exact 'Install-OMEN.ps1' `
    'maxStartsPerCycle=2;maxThreadsPerCycle=32;cycleBudgetMs=45000;requestTimeoutMs=5000' `
    'maxStartsPerCycle=$null;maxThreadsPerCycle=$null;maxParentNoticesPerCycle=$null;cycleBudgetMs=$null;requestTimeoutMs=$null'
Replace-Exact 'Native-Node.ps1' `
    'if(-not $process.WaitForExit(120000)){throw (''Recovery command timed out. Inspect PID ''+$process.Id+'' before retrying.'')}' `
    '$process.WaitForExit()'
Replace-Exact 'payload/control/Register-SystemErrorRecovery.ps1' `
    '(New-TimeSpan -Minutes 5)' '([TimeSpan]::Zero)'
Replace-Exact 'Check-Runtime.mjs' 'timeoutMilliseconds: 10000' 'timeoutMilliseconds: null'
Replace-Exact 'Check-Runtime.mjs' 'requestTimeoutMs: 10000' 'requestTimeoutMs: null'
# Keep the package's standalone adapter and never copy a foreign config/journal.
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'system-error-recovery.mjs') `
    -Destination (Join-Path $stage 'payload/control/system-error-recovery.mjs')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'system-error-recovery.test.mjs') `
    -Destination (Join-Path $stage 'tests/system-error-recovery.test.mjs')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'system-error-parent-notice-queue.test.mjs') `
    -Destination (Join-Path $stage 'tests/system-error-parent-notice-queue.test.mjs')
$derivation = [ordered]@{
    schemaVersion = 1; computerName = [Net.Dns]::GetHostName(); sourcePackageRoot = $PackageRoot;
    sourceManifestSha256 = (Get-FileHash -LiteralPath $sourceManifestPath -Algorithm SHA256).Hash;
    controlRoot = $controlRoot; stage = $stage; createdAt = [DateTimeOffset]::Now.ToString('o');
    limitAuthority = 'Owner AGENTS section 9: no unsupported agent-created count/time ceilings';
    retainedContracts = @('one-minute logon/interactive schedule', 'IgnoreNew and exclusive episode claims',
        'API rate/goal budget constraints', 'exact latest terminal failure and same-thread identity',
        'numeric backoff representation must remain a safe JavaScript integer');
    sourcePins = @(foreach ($relative in @('control/system-error-recovery.mjs',
        'discord-bridge/src/app-server-client.mjs', 'control/codex-shared.mjs')) {
        @{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $controlRoot $relative) -Algorithm SHA256).Hash}
    })
}
$derivation | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'local-adjustments.json') -Encoding UTF8
$derivedManifest = @{schemaVersion=1;files=@(foreach ($entry in $sourceManifest.files) {
    $file=Get-Item -LiteralPath (Join-Path $stage $entry.path)
    @{path=$entry.path;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant();byteLength=$file.Length}
})}
$derivedManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage 'package-manifest.json') -Encoding UTF8
Write-Output ('Derived validated package: ' + $stage)
& (Join-Path $stage 'Install-OMEN.ps1') -ControlRoot $controlRoot -InstallRoot $InstallRoot `
    -NodePath $NodePath -PythonwPath $PythonwPath -ExcludedThreadIds $ExcludedThreadIds `
    -CheckOnly:$CheckOnly -PrepareOnly:$PrepareOnly
if (-not $CheckOnly) {
    Copy-Item -LiteralPath (Join-Path $stage 'local-adjustments.json') -Destination $InstallRoot
}
