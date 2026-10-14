[CmdletBinding()]
param([Parameter(Mandatory)][string]$JobPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility')) {
    Import-Module "C:\Windows\System32\WindowsPowerShell\v1.0\Modules\$module\$module.psd1" -ErrorAction Stop
}
. (Join-Path $PSScriptRoot 'Read-AtomicJson.ps1')
$initial = Read-AtomicJsonSnapshot -LiteralPath $JobPath
if ($initial.phase -ne 'ready') { throw 'Initial job unavailable; do not replay.' }
$job = $initial.value
if (Test-Path -LiteralPath $job.receiptPath) { throw 'Existing admitted receipt; no replay.' }
$receipt = [ordered]@{
    operationId = $job.operationId; phase = 'admitted'; readOnly = $true; workerPid = $PID
    targetThreadId = $job.targetThreadId; requestReplayed = $false; restart = $false
    installation = $false; otherTasksResumed = $false; secretsRead = $false
    transientReadCount = 0; startedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
function Save-Receipt {
    $receipt.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $temporary = "$($job.receiptPath).$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $job.receiptPath -Force
}
function Test-BridgeIdentity {
    $actual = Get-Process -Id $job.expectedBridge.pid -ErrorAction SilentlyContinue
    return $actual -and $actual.StartTime.ToUniversalTime().Ticks -eq ([DateTimeOffset]$job.expectedBridge.startTimeUtc).UtcDateTime.Ticks -and
        [string]::Equals($actual.Path, $job.expectedBridge.path, [StringComparison]::OrdinalIgnoreCase)
}
$watcher = $null
$readRole = 'admission'
try {
    foreach ($pin in $job.pins) {
        if ((Get-FileHash -LiteralPath $pin.path -Algorithm SHA256).Hash -ne $pin.sha256) { throw 'Pinned code changed.' }
    }
    if (-not (Test-BridgeIdentity)) { throw 'Expected process identity changed.' }
    $watcher = [IO.FileSystemWatcher]::new([IO.Path]::GetDirectoryName($job.runtimePath))
    $watcher.Filter = '*'
    $watcher.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::LastWrite
    $watcher.EnableRaisingEvents = $true
    $receipt.phase = 'waiting-existing-request'; $receipt.diagnosticAt = $job.diagnosticAt; Save-Receipt
    while ($true) {
        if (Test-Path -LiteralPath $job.cancelPath) { $receipt.phase = 'cancelled-observation-only'; break }
        if (-not (Test-BridgeIdentity)) { $receipt.phase = 'runtime-changed'; break }
        $readRole = 'runtime'
        $runtimeRead = Read-AtomicJsonSnapshot -LiteralPath $job.runtimePath
        $readRole = 'binding-state'
        $stateRead = Read-AtomicJsonSnapshot -LiteralPath $job.statePath
        $remaining = ([DateTimeOffset]$job.diagnosticAt - [DateTimeOffset]::UtcNow).TotalMilliseconds
        $deferred = @(@($runtimeRead, $stateRead) | Where-Object { $_.phase -ne 'ready' })
        if ($deferred.Count) {
            $receipt.transientReadCount += $deferred.Count
            $receipt.lastTransientRead = @($deferred | Select-Object phase, win32Error)
            if ($receipt.transientReadCount -eq $deferred.Count) { Save-Receipt }
            if ($remaining -le 0) { $receipt.phase = 'diagnostic-state-unreadable'; break }
            [void]$watcher.WaitForChanged([IO.WatcherChangeTypes]::All, [int][Math]::Min($remaining, [int]::MaxValue))
            continue
        }
        $runtime = $runtimeRead.value
        $state = $stateRead.value
        if ($runtime.pid -ne $job.expectedBridge.pid -or $runtime.phase -ne 'running') { $receipt.phase = 'runtime-changed'; break }
        $property = $state.bindings.PSObject.Properties[$job.targetThreadId]
        $binding = if ($property) { $property.Value } else { $null }
        $channelProperty = if ($binding) { $binding.PSObject.Properties['channelId'] } else { $null }
        $panelProperty = if ($binding) { $binding.PSObject.Properties['controlPanelMessageId'] } else { $null }
        if ($channelProperty -and $channelProperty.Value -and $panelProperty -and $panelProperty.Value) {
            $receipt.phase = 'mirror-ready-for-verification'; $receipt.channelId = $channelProperty.Value; $receipt.panelId = $panelProperty.Value; break
        }
        $pendingProperty = $runtime.taskSync.PSObject.Properties['pendingThreads']
        $pending = @(if ($pendingProperty) { $pendingProperty.Value | Where-Object { $_.threadId -eq $job.targetThreadId } })
        if ($pending.Count -ne 1 -or $pending[0].phase -ne 'channelCreate') {
            $receipt.phase = 'create-phase-settled-or-advanced'; $receipt.observedTaskSync = $runtime.taskSync; break
        }
        if ($remaining -le 0) { $receipt.phase = 'diagnostic-window-elapsed-request-still-unknown'; $receipt.observedTaskSync = $runtime.taskSync; break }
        [void]$watcher.WaitForChanged([IO.WatcherChangeTypes]::All, [int][Math]::Min($remaining, [int]::MaxValue))
    }
    Save-Receipt
} catch {
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    $receipt.phase = 'observation-failed'; $receipt.errorType = $failure.GetType().FullName
    $receipt.errorHResult = $failure.HResult; $receipt.readRole = $readRole
    $receipt.errorLine = $_.InvocationInfo.ScriptLineNumber
    Save-Receipt
    exit 1
} finally {
    if ($watcher) { $watcher.Dispose() }
}
$receipt | ConvertTo-Json -Depth 6
