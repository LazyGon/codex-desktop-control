function Write-CodexComponentReceipt {
    param($Receipt, [string]$JournalPath, [string]$ResultPath)
    $Receipt.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Receipt | ConvertTo-Json -Depth 8))
    foreach ($destination in @($JournalPath,$ResultPath) | Select-Object -Unique) {
        $temporary = "$destination.$PID.$([guid]::NewGuid().ToString('N')).tmp"
        $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        # Both destinations were exclusively reserved before any dispatch.
        [IO.File]::Replace($temporary,$destination,[NullString]::Value)
    }
}

function Invoke-CodexComponentSender {
    param([string]$ScriptPath, [string[]]$Arguments)
    $shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $PSHOME $shell
    # Fixed named arguments and filesystem paths cannot contain Windows quote characters.
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $ScriptPath + '" ' +
        (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $sender = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $sender.StandardOutput.ReadToEndAsync()
        $stderr = $sender.StandardError.ReadToEndAsync()
        if (-not $sender.WaitForExit(10000)) { throw 'Graceful sender result is unknown; no fallback dispatch is allowed.' }
        $null = $stdout.GetAwaiter().GetResult(); $null = $stderr.GetAwaiter().GetResult()
        [pscustomobject]@{ accepted = ($sender.ExitCode -eq 0); exitCode = $sender.ExitCode }
    }
    finally { $sender.Dispose() }
}

function Request-CodexComponentGraceful {
    param($Entry, [string]$LauncherRoot, [string]$JournalPath)
    switch ($Entry.target.role) {
        'server' {
            $signalPath = "$JournalPath.signal-$($Entry.target.pid).txt"
            Invoke-CodexComponentSender (Join-Path $LauncherRoot 'Send-CodexAppServerShutdown.ps1') @(
                '-ServerId', [string]$Entry.target.pid, '-Executable', $Entry.target.executable,
                '-StartedUtcTicks', [string]$Entry.process.StartTime.ToUniversalTime().Ticks,
                '-ResultPath', $signalPath)
        }
        'desktop' { [pscustomobject]@{ accepted = $Entry.process.CloseMainWindow() } }
        'bridge' {
            $bridgeRoot = Join-Path (Split-Path -Parent $LauncherRoot) 'discord-bridge'
            $lockPath = Join-Path $bridgeRoot 'data\bridge.lock'
            $runtime = Read-CodexComponentJson (Join-Path $bridgeRoot 'data\runtime.json')
            if (-not (Test-Path -LiteralPath $lockPath) -or
                (Get-Content -LiteralPath $lockPath -Raw).Trim() -cne [string]$Entry.target.pid -or
                [int](Get-CodexComponentValue $runtime 'pid') -ne $Entry.target.pid -or
                -not (Test-CodexComponentPath (Get-CodexComponentValue $runtime 'bridgeRoot') $bridgeRoot)) {
                throw 'Bridge lock/runtime changed before its graceful request.'
            }
            Invoke-CodexComponentSender (Join-Path $bridgeRoot 'Stop-DiscordBridge.ps1') @('-NoWait')
        }
    }
}

function Wait-CodexComponentEntries {
    param([object[]]$Entries, [int]$TimeoutMilliseconds)
    $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    foreach ($entry in $Entries) {
        if ($null -eq $entry.process) { $entry.record.exited = $true; continue }
        $remaining = [Math]::Max(0, [int]($deadline - [DateTimeOffset]::UtcNow).TotalMilliseconds)
        $entry.record.exited = $entry.process.WaitForExit($remaining)
    }
}

function Invoke-CodexComponentStop {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('Shared','Desktop','Bridge')][string]$Component,
        [Parameter(Mandatory)][guid]$OperationId,
        [Parameter(Mandatory)][string]$ResultPath,
        [Parameter(Mandatory)][string]$LauncherRoot,
        [switch]$Force,
        [ValidateRange(0,30)][int]$GracefulTimeoutSeconds = 5
    )
    if ($OperationId -eq [guid]::Empty) { throw 'OperationId must be a new nonempty UUID.' }
    $LauncherRoot = [IO.Path]::GetFullPath($LauncherRoot)
    $ResultPath = [IO.Path]::GetFullPath($ResultPath)
    $journalRoot = Join-Path $LauncherRoot 'state\component-stops'
    $null = [IO.Directory]::CreateDirectory($journalRoot)
    $journalPath = Join-Path $journalRoot ($OperationId.ToString('D') + '.json')
    $receipt = [ordered]@{
        schemaVersion = 1; operationId = $OperationId.ToString('D'); component = $Component
        phase = 'planned'; outcome = 'pending'; forceAuthorized = [bool]$Force
        requestedAt = [DateTimeOffset]::UtcNow.ToString('o'); updatedAt = ''; targets = @(); error = $null
        journalPath = $journalPath; resultPath = $ResultPath
    }
    # The immutable existence of this request fences every phase, including a crash
    # before dispatch and an unknown result. A different result path cannot replay it.
    $claim = [IO.File]::Open($journalPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 8))
        $claim.Write($bytes,0,$bytes.Length); $claim.Flush($true)
    }
    finally { $claim.Dispose() }
    if (-not (Test-CodexComponentPath $ResultPath $journalPath)) {
        # Refuse an existing UI receipt, even if its operation ID differs.
        try {
            $result = [IO.File]::Open($ResultPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            $result.Dispose()
        }
        catch {
            $receipt.phase = 'failed'; $receipt.outcome = 'receipt-unavailable'; $receipt.error = $_.Exception.Message
            Write-CodexComponentReceipt $receipt $journalPath $journalPath
            throw
        }
    }
    $entries = @(); $componentLock = $null; $dispatched = $false
    try {
        Write-CodexComponentReceipt $receipt $journalPath $ResultPath
        $componentLock = [IO.File]::Open((Join-Path $journalRoot "$Component.lock"),[IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $snapshot = Get-CodexComponentSnapshot $Component $LauncherRoot
        $targets = @(Select-CodexComponentTargets $Component $LauncherRoot $snapshot)
        foreach ($target in $targets) {
            $record = [ordered]@{
                pid = $target.pid; parentPid = $target.parentPid; executable = $target.executable
                startedAt = $target.startedAt; session = $target.session; sid = $snapshot.sid; role = $target.role
                gracefulRequested = $false; gracefulAccepted = $null
                forceRequested = $false; forceAccepted = $null; exited = $false
            }
            $process = Open-CodexComponentProcess $target $snapshot.sid $snapshot.session
            if ($null -eq $process) { $record.exited = $true }
            $entries += [pscustomobject]@{ target = $target; process = $process; record = $record }
            $receipt.targets = @($entries | ForEach-Object record)
        }
        Write-CodexComponentReceipt $receipt $journalPath $ResultPath
        foreach ($entry in $entries) {
            if ($null -eq $entry.process -or $entry.process.HasExited) { $entry.record.exited = $true; continue }
            if ($entry.target.role -notin @('server','desktop','bridge')) { continue }
            if (-not (Assert-CodexComponentIdentity $entry.target $entry.process $snapshot.sid $snapshot.session)) {
                $entry.record.exited = $true; continue
            }
            $receipt.phase = 'dispatching'; $entry.record.gracefulRequested = $true
            Write-CodexComponentReceipt $receipt $journalPath $ResultPath
            $dispatched = $true
            $reply = Request-CodexComponentGraceful $entry $LauncherRoot $journalPath
            $entry.record.gracefulAccepted = [bool]$reply.accepted
            Write-CodexComponentReceipt $receipt $journalPath $ResultPath
        }
        Wait-CodexComponentEntries $entries ($GracefulTimeoutSeconds * 1000)
        if ($Force) {
            # Stop the Bridge restart owner first, then its pinned Node/wrapper.
            # Package helpers go before roots; Shared has no automatic restart owner.
            $orderedEntries = @($entries | Sort-Object @{Expression={
                switch ($_.target.role) { 'bridge-host' {0} 'desktop-helper' {0} 'server' {1} 'desktop' {1} 'bridge' {1} default {2} }
            }})
            foreach ($entry in $orderedEntries) {
                if ($entry.record.exited) { continue }
                if (-not (Assert-CodexComponentIdentity $entry.target $entry.process $snapshot.sid $snapshot.session)) {
                    $entry.record.exited = $true; continue
                }
                $receipt.phase = 'dispatching'; $entry.record.forceRequested = $true
                Write-CodexComponentReceipt $receipt $journalPath $ResultPath
                $dispatched = $true
                $entry.process.Kill()
                $entry.record.forceAccepted = $true
                Write-CodexComponentReceipt $receipt $journalPath $ResultPath
                $entry.record.exited = $entry.process.WaitForExit(5000)
                if (-not $entry.record.exited) { throw 'Termination was accepted but actual exit is unconfirmed.' }
            }
        }
        $remaining = @($entries | Where-Object { -not $_.record.exited })
        if ($remaining.Count -gt 0) { $receipt.phase = 'failed'; $receipt.outcome = 'still-running' }
        else {
            $receipt.phase = 'completed'
            $receipt.outcome = if ($targets.Count -eq 0) { 'not-running' } elseif ($dispatched) { 'stopped' } else { 'already-exited' }
        }
    }
    catch {
        $receipt.phase = if ($dispatched) { 'unknown' } else { 'failed' }
        $receipt.outcome = if ($dispatched) { 'exit-unconfirmed' } else { 'refused' }
        $receipt.error = $_.Exception.Message
    }
    finally {
        foreach ($entry in $entries) { if ($null -ne $entry.process) { $entry.process.Dispose() } }
        if ($null -ne $componentLock) { $componentLock.Dispose() }
    }
    Write-CodexComponentReceipt $receipt $journalPath $ResultPath
    [pscustomobject]$receipt
}
