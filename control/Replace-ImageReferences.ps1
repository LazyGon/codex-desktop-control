param([Parameter(Mandatory = $true)][string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$target = [IO.Path]::GetFullPath($job.archivePath)
$root = [IO.Path]::GetFullPath($job.archiveRoot)
$candidate = [IO.Path]::GetFullPath($job.manifest.outputPath)
$backup = [IO.Path]::GetFullPath($job.backupPath)
$stage = $target + '.' + [guid]::Parse($job.operationId).ToString() + '.tmp'
$resultPath = [IO.Path]::GetFullPath($job.resultPath)
if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFileName($target).EndsWith('-' + $job.threadId + '.jsonl'))) {
    throw 'Archive is outside the target thread storage.'
}
foreach ($file in @($backup, $stage, $resultPath)) {
    if (Test-Path -LiteralPath $file) { throw 'Existing operation artifact; inspect without replay.' }
}
$result = [ordered]@{ operationId = $job.operationId; status = 'preflight'; backupPath = $backup }
function Save-Result([string]$Status) {
    $result.status = $Status
    $temporary = $resultPath + '.tmp'
    $json = $result | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $resultPath) { [IO.File]::Replace($temporary, $resultPath, $resultPath + '.previous', $false) }
    else { [IO.File]::Move($temporary, $resultPath) }
}
function Hash-File([string]$File) {
    return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Hash-Exclusive([string]$File) {
    $stream = [IO.File]::Open($File, 'Open', 'ReadWrite', 'None')
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
try {
    Save-Result 'preflight'
    if ((Get-Item -LiteralPath $target).Length -ne $job.manifest.byteLength -or
        (Get-Item -LiteralPath $candidate).Length -ne $job.manifest.byteLength -or
        (Hash-File $candidate) -ne $job.manifest.outputSha256 -or
        (Hash-Exclusive $target) -ne $job.manifest.sourceSha256) { throw 'Source or candidate changed.' }
    foreach ($asset in $job.manifest.assets) {
        if ((Get-Item -LiteralPath $asset.path).Length -ne $asset.byteLength -or
            (Hash-File $asset.path) -ne $asset.sha256) { throw 'Saved image changed or missing.' }
    }
    $acl = Get-Acl -LiteralPath $target
    [IO.File]::Copy($candidate, $stage, $false)
    if ((Hash-File $stage) -ne $job.manifest.outputSha256 -or
        (Hash-Exclusive $target) -ne $job.manifest.sourceSha256) { throw 'Source changed before replace.' }
    Save-Result 'replacing'
    [IO.File]::Replace($stage, $target, $backup, $false)
    Save-Result 'replaced-verifying'
    $result.appliedSha256 = Hash-File $target
    $result.backupSha256 = Hash-File $backup
    if ($result.appliedSha256 -ne $job.manifest.outputSha256 -or
        $result.backupSha256 -ne $job.manifest.sourceSha256) { throw 'Replacement hash mismatch; do not replay.' }
    if ((Get-Acl -LiteralPath $target).Sddl -ne $acl.Sddl) {
        Set-Acl -LiteralPath $target -AclObject $acl
        if ((Get-Acl -LiteralPath $target).Sddl -ne $acl.Sddl) { throw 'ACL preservation failed.' }
    }
    Save-Result 'verified'
} catch {
    $result.failedPhase = $result.status
    $result.error = $_.Exception.Message
    Save-Result 'failed-or-unknown'
    throw
}
