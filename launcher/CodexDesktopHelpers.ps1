function Get-CodexDesktopHelperKind {
    param([string]$CommandLine)
    $m = [regex]::Match($CommandLine, '(?:^|\s)--type=(crashpad-handler|utility|renderer|gpu-process)(?=\s|$)')
    if ($m.Success) { $m.Groups[1].Value }
}

function Select-CodexDesktopHelperCandidates {
    param([object]$Root, [object[]]$Processes)
    $ancestry = @{}
    $ancestry[[int]$Root.ProcessId] = [datetime]$Root.CreationDate
    foreach ($row in ($Processes | Sort-Object CreationDate)) {
        $parent = [int]$row.ParentProcessId
        if ($row.ProcessId -eq $Root.ProcessId -or -not $ancestry.ContainsKey($parent) -or
            $row.ExecutablePath -ne $Root.ExecutablePath -or $row.SessionId -ne $Root.SessionId -or
            [datetime]$row.CreationDate -lt $ancestry[$parent]) { continue }
        $kind = Get-CodexDesktopHelperKind $row.CommandLine
        if (-not $kind) { continue }
        $ancestry[[int]$row.ProcessId] = [datetime]$row.CreationDate
        [pscustomobject]@{
            pid = [int]$row.ProcessId; parentPid = $parent; executable = $row.ExecutablePath
            created = ([datetime]$row.CreationDate).ToUniversalTime().ToString('o')
            session = [int]$row.SessionId; kind = $kind
        }
    }
}

function Stop-CodexExitedDesktopHelpers {
    param([object]$RootActor, [object[]]$Candidates, [string]$ReceiptPath)
    if ((Test-Path -LiteralPath $ReceiptPath) -or (Test-CodexHandoffActorAlive $RootActor)) {
        throw 'The helper cleanup already has a receipt, or its Desktop root has not exited. No helper was stopped.'
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $matched = @()
    $records = @()
    try {
        foreach ($candidate in $Candidates) {
            $row = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$candidate.pid)"
            if (-not $row) { continue }
            if ($candidate.pid -eq $RootActor.pid -or $row.ExecutablePath -ne $RootActor.executable -or
                $row.ExecutablePath -ne $candidate.executable -or $row.SessionId -ne $session -or
                $row.SessionId -ne $candidate.session -or $row.ParentProcessId -ne $candidate.parentPid -or
                ([datetime]$row.CreationDate).ToUniversalTime().ToString('o') -ne $candidate.created -or
                -not $candidate.kind -or (Get-CodexDesktopHelperKind $row.CommandLine) -ne $candidate.kind -or
                ($row | Invoke-CimMethod -MethodName GetOwnerSid).Sid -ne $sid) {
                throw 'A residual helper identity changed. No further termination is authorized.'
            }
            $process = [Diagnostics.Process]::GetProcessById([int]$candidate.pid)
            $matched += [pscustomobject]@{ process = $process; candidate = $candidate }
            # Retain this process handle through termination and exit readback.
            $null = $process.Handle
            $creationTicks = [datetimeoffset]::Parse($candidate.created).UtcDateTime.Ticks
            # WMI's CreationDate is precise to a microsecond; round FILETIME down to that same precision.
            $actualTicks = $process.StartTime.ToUniversalTime().Ticks
            if ($process.HasExited -or $process.Path -ne $candidate.executable -or
                ($actualTicks - ($actualTicks % 10)) -ne $creationTicks) {
                throw 'The retained helper process handle does not match the verified identity.'
            }
        }

        $receipt = [ordered]@{ phase = 'prepared'; root = $RootActor; helpers = @($matched | ForEach-Object candidate); terminated = @() }
        Write-CodexHandoffJson $ReceiptPath $receipt
        # Stop the deepest children first. Each PID is dispatched at most once.
        for ($i = $matched.Count - 1; $i -ge 0; $i--) {
            $entry = $matched[$i]
            if ($entry.process.HasExited) { continue }
            if (Test-CodexHandoffActorAlive $RootActor) { throw 'Desktop root is not confirmed exited.' }
            $receipt.phase = 'termination-requested'; $receipt.pendingPid = $entry.candidate.pid
            Write-CodexHandoffJson $ReceiptPath $receipt
            $entry.process.Kill()
            $entry.process.WaitForExit()
            $records += $entry.candidate.pid
            $receipt.terminated = $records
            $receipt.Remove('pendingPid')
            $receipt.phase = 'observed-exit'
            Write-CodexHandoffJson $ReceiptPath $receipt
        }
        $receipt.phase = 'completed'
        Write-CodexHandoffJson $ReceiptPath $receipt
        $records
    }
    finally {
        foreach ($entry in $matched) { $entry.process.Dispose() }
    }
}
