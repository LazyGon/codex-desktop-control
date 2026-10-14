[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility')) {
    Import-Module "C:\Windows\System32\WindowsPowerShell\v1.0\Modules\$module\$module.psd1" -ErrorAction Stop
}
. (Join-Path $PSScriptRoot 'Read-AtomicJson.ps1')
$fixtureBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureName = 'codex-atomicjson-test-' + [guid]::NewGuid().ToString()
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $fixtureBase $fixtureName))
[void][IO.Directory]::CreateDirectory($fixtureRoot)
$checks = [Collections.Generic.List[string]]::new()
function Assert-Fact($fact, $name) { if (-not $fact) { throw $name }; $checks.Add($name) }
function Write-Fixture($file, $value) {
    $temporary = "$file.next"
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, "$file.prior") }
    else { [IO.File]::Move($temporary, $file) }
}
$hold = $null
$stream = $null
$signals = $null
$worker = $null
try {
    $file = Join-Path $fixtureRoot 'snapshot.json'
    $unicode = [string]::Concat([char]0x65e5, [char]0x672c, [char]0x8a9e) + [char]::ConvertFromUtf32(0x1f63a)
    Write-Fixture $file @{ text = $unicode; generation = 1 }
    Assert-Fact ((Read-AtomicJsonSnapshot $file).value.text -ceq $unicode) 'strict-utf8-japanese-and-emoji'
    $stream = Open-AtomicJsonReadStream $file
    Write-Fixture $file @{ generation = 2 }
    $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true))
    $retained = $reader.ReadToEnd() | ConvertFrom-Json
    $reader.Dispose(); $stream = $null
    Assert-Fact ($retained.generation -eq 1 -and (Read-AtomicJsonSnapshot $file).value.generation -eq 2) 'atomic-replace-retains-complete-open-generation'
    $hold = [IO.File]::Open($file, 'Open', 'ReadWrite', 'None')
    $locked = Read-AtomicJsonSnapshot $file
    Assert-Fact ($locked.phase -eq 'temporarily-unavailable' -and $locked.win32Error -eq 32 -and $null -eq $locked.value) 'exclusive-share-defers-read-only'
    $hold.Dispose(); $hold = $null
    Assert-Fact ((Read-AtomicJsonSnapshot $file).value.generation -eq 2) 'release-allows-same-snapshot'
    $missingRejected = $false
    try { [void](Read-AtomicJsonSnapshot (Join-Path $fixtureRoot 'missing.json')) } catch { $missingRejected = $true }
    Assert-Fact $missingRejected 'missing-file-is-not-transient-sharing'
    $invalid = Join-Path $fixtureRoot 'invalid.json'
    [IO.File]::WriteAllText($invalid, '{bad json', [Text.UTF8Encoding]::new($false))
    $invalidRejected = $false
    try { [void](Read-AtomicJsonSnapshot $invalid) } catch { $invalidRejected = $true }
    Assert-Fact $invalidRejected 'malformed-json-fails-closed'
    [IO.File]::WriteAllBytes($invalid, [byte[]]@(0xff, 0xfe, 0xff))
    $encodingRejected = $false
    try { [void](Read-AtomicJsonSnapshot $invalid) } catch { $encodingRejected = $true }
    Assert-Fact $encodingRejected 'invalid-utf8-fails-closed'

    $parentProcess = Get-Process -Id $PID
    $runtimePath = Join-Path $fixtureRoot 'runtime.json'
    $statePath = Join-Path $fixtureRoot 'state.json'
    $receiptPath = Join-Path $fixtureRoot 'receipt.json'
    $jobPath = Join-Path $fixtureRoot 'job.json'
    $workerPath = Join-Path $PSScriptRoot 'Wait-TaskMirror.ps1'
    $helperPath = Join-Path $PSScriptRoot 'Read-AtomicJson.ps1'
    Write-Fixture $runtimePath @{ pid = $PID; phase = 'running'; taskSync = @{ pendingThreads = @(@{threadId = 'test-task'; phase = 'channelCreate'}) } }
    Write-Fixture $statePath @{ bindings = @{} }
    Write-Fixture $jobPath @{
        operationId = [guid]::NewGuid().ToString(); targetThreadId = 'test-task'
        runtimePath = $runtimePath; statePath = $statePath; receiptPath = $receiptPath
        cancelPath = (Join-Path $fixtureRoot 'cancel'); diagnosticAt = [DateTimeOffset]::UtcNow.AddSeconds(20).ToString('o')
        expectedBridge = @{ pid = $PID; path = $parentProcess.Path; startTimeUtc = $parentProcess.StartTime.ToUniversalTime().ToString('o') }
        pins = @(@{path = $workerPath; sha256 = (Get-FileHash $workerPath).Hash}, @{path = $helperPath; sha256 = (Get-FileHash $helperPath).Hash})
    }
    $hold = [IO.File]::Open($statePath, 'Open', 'ReadWrite', 'None')
    $signals = [IO.FileSystemWatcher]::new($fixtureRoot)
    $signals.EnableRaisingEvents = $true
    $worker = [Diagnostics.Process]::new()
    $worker.StartInfo = [Diagnostics.ProcessStartInfo]::new('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', ('-NoProfile -NonInteractive -File "' + $workerPath + '" -JobPath "' + $jobPath + '"'))
    $worker.StartInfo.UseShellExecute = $false
    $worker.StartInfo.CreateNoWindow = $true
    $worker.StartInfo.RedirectStandardOutput = $true
    $worker.StartInfo.RedirectStandardError = $true
    [void]$worker.Start()
    $testDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while ($true) {
        if ([IO.File]::Exists($receiptPath)) {
            $observed = Read-AtomicJsonSnapshot $receiptPath
            if ($observed.phase -eq 'ready' -and $observed.value.transientReadCount -gt 0) { break }
        }
        $remaining = ($testDeadline - [DateTimeOffset]::UtcNow).TotalMilliseconds
        if ($remaining -le 0) { throw 'fixture-worker-did-not-observe-controlled-sharing' }
        [void]$signals.WaitForChanged([IO.WatcherChangeTypes]::All, [int]$remaining)
    }
    $hold.Dispose(); $hold = $null
    Write-Fixture $statePath @{ bindings = @{ 'test-task' = @{ channelId = 'fixture-channel'; controlPanelMessageId = 'fixture-panel' } } }
    $finished = $worker.WaitForExit(10000)
    $result = (Read-AtomicJsonSnapshot $receiptPath).value
    if (-not $finished -or $worker.ExitCode -ne 0) {
        throw ('fixture-worker-failed: ' + ($result | Select-Object phase, errorType, errorHResult, readRole, errorLine | ConvertTo-Json -Compress))
    }
    Assert-Fact $finished 'event-worker-finishes-without-replaying-any-request'
    Assert-Fact ($result.phase -eq 'mirror-ready-for-verification' -and $result.transientReadCount -gt 0 -and -not $result.requestReplayed -and -not $result.restart) 'event-worker-recovers-sharing-and-retains-read-only-boundary'
    $worker.Dispose()
    $worker = $null
    [pscustomobject]@{ passed = $true; checks = $checks.ToArray(); count = $checks.Count } | ConvertTo-Json -Depth 3
} finally {
    if ($hold) { $hold.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($signals) { $signals.Dispose() }
    if ($worker -and -not $worker.HasExited) {
        [IO.File]::WriteAllText((Join-Path $fixtureRoot 'cancel'), 'test cleanup')
        if (-not $worker.WaitForExit(10000)) { throw 'fixture-worker-still-alive; preserve evidence, no forced termination' }
    }
    if ($worker) { $worker.Dispose() }
    # Only this test's newly created, resolved temporary fixture directory.
    if ($fixtureRoot.StartsWith($fixtureBase, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fixtureRoot) -eq $fixtureName) { [IO.Directory]::Delete($fixtureRoot, $true) }
}
