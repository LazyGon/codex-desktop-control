param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$root = 'C:\ProgramData\CodexAdminTerminal'
$config = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$state = Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$target = Join-Path $root 'guard.mjs'
$source = Join-Path $config.controlRoot 'admin-terminal\guard.mjs'
$backup = Join-Path $root ('guard.before-' + $job.operationId + '.mjs')
$updatePath = Join-Path $root 'guard-update.json'
$receipt = [ordered]@{ operationId = $job.operationId; phase = 'preflight'; checks = @{}; noHostRestart = $true; noPolicyChanges = $true }
function Save-RepairReceipt {
    $temporary = $job.receiptPath + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $job.receiptPath)
}
function Assert-ProtectedFile([string]$File) {
    $acl = Get-Acl -LiteralPath $File
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw 'Protected owner changed.' }
    foreach ($rule in $acl.Access) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($rule.AccessControlType -ne 'Allow' -or $sid -in 'S-1-5-18','S-1-5-32-544') { continue }
        $write = [Security.AccessControl.FileSystemRights]'Write,Delete,ChangePermissions,TakeOwnership'
        if ($sid -ne $config.userSid -or ($rule.FileSystemRights -band $write)) { throw 'Protected file is writable by an unprivileged principal.' }
    }
    $acl.Sddl
}
if (Test-Path -LiteralPath $job.receiptPath) { throw 'Repair receipt exists; never replay.' }
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $identity.User.Value -ne $config.userSid) { throw 'Use the verified common administrator host.' }
    if ($state.phase -ne 'executing' -or $state.activeOperationId -ne $job.operationId) { throw 'This repair is not the exact executing administrator operation.' }
    $hostProcess = Get-Process -Id $state.pid
    if ($state.pid -ne $job.expectedHostPid -or $state.processStartTime -ne $job.expectedHostStartTime -or -not $state.elevated -or $hostProcess.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]$state.processStartTime).UtcDateTime.Ticks) { throw 'Administrator host identity changed.' }
    if ([IO.Path]::GetFullPath($job.sourcePath) -ne [IO.Path]::GetFullPath($source)) { throw 'Only the reviewed guard source may be installed.' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $job.sourceSha256 -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $job.beforeSha256) { throw 'Source or installed guard changed; no overwrite.' }
    if ((Test-Path -LiteralPath $backup) -or (Test-Path -LiteralPath $updatePath)) { throw 'Guard update evidence exists; inspect rather than replay.' }
    $beforeAcl = Assert-ProtectedFile $target
    $receipt.phase = 'replace-dispatching'
    $temporary = Join-Path $root ('guard.' + $job.operationId + '.tmp')
    [IO.File]::WriteAllBytes($temporary, [IO.File]::ReadAllBytes($source))
    [IO.File]::Replace($temporary, $target, $backup)
    $installedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($installedHash -ne $job.sourceSha256 -or (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $job.beforeSha256) { throw 'Replacement or recoverable backup hash mismatch; do not replay.' }
    $afterAcl = Assert-ProtectedFile $target
    if ($beforeAcl -ne $afterAcl) { throw 'Guard ACL changed; inspect without changing permissions.' }
    $code = 'const {pathToFileURL}=require("node:url");(async()=>{const m=await import(pathToFileURL(process.argv[2]).href);process.stdout.write(m.guardResultJson({workspace:"\u65e5\u672c\u8a9e\ud83d\ude00",sandbox:"dangerFullAccess",approvalPolicy:"never"}));})().catch(()=>process.exit(1));'
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $config.nodePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::GetEncoding(932)
    $info.Arguments = '-e "' + $code.Replace('"','\"') + '" guard-envelope-check "' + $target + '"'
    $probe = [Diagnostics.Process]::Start($info)
    $out = $probe.StandardOutput.ReadToEndAsync()
    $err = $probe.StandardError.ReadToEndAsync()
    $probe.WaitForExit()
    try {
        if ($probe.ExitCode -ne 0) { throw 'Installed envelope probe failed.' }
        $text = $out.GetAwaiter().GetResult()
        if ($text -match '[^\x00-\x7f]') { throw 'Installed guard did not produce an ASCII envelope.' }
        $decoded = $text | ConvertFrom-Json
        $expected = [string][char]0x65e5 + [char]0x672c + [char]0x8a9e + [char]::ConvertFromUtf32(0x1f600)
        if ($decoded.workspace -ne $expected -or $decoded.sandbox -ne 'dangerFullAccess' -or $decoded.approvalPolicy -ne 'never') { throw 'Japanese/emoji envelope read or permission fields changed.' }
    } finally { $probe.Dispose() }
    $update = [ordered]@{ operationId = $job.operationId; file = 'guard.mjs'; beforeSha256 = $job.beforeSha256; sourceSha256 = $job.sourceSha256; installedSha256 = $installedHash; phase = 'installed'; installedAt = [DateTimeOffset]::Now.ToString('o'); guardAclUnchanged = $true; asciiEnvelopeVerified = $true; shiftJisRoundTripVerified = $true; backupPath = $backup }
    [IO.File]::WriteAllText($updatePath, ($update | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $updateAcl = Get-Acl -LiteralPath $updatePath
    $updateAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    Set-Acl -LiteralPath $updatePath -AclObject $updateAcl
    $null = Assert-ProtectedFile $updatePath
    $receipt.phase = 'installed'
    $receipt.sourceSha256 = $job.sourceSha256
    $receipt.installedSha256 = $installedHash
    $receipt.checks = @{ actualAdminToken = $true; exactLiveHost = $true; guardAclUnchanged = $true; sourceAndInstalledHash = $true; recoverableBackup = $true; asciiEnvelope = $true; shiftJisJapaneseEmojiRoundTrip = $true; permissionFieldsPreserved = $true }
    $receipt.finishedAt = [DateTimeOffset]::Now.ToString('o')
    Save-RepairReceipt
} catch {
    $receipt.phase = 'failed-do-not-replay'
    $receipt.reason = $_.Exception.Message
    Save-RepairReceipt
    exit 1
}
