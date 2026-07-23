[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f-]{36}$')]
    [string]$WaitForThreadId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f-]{36}$')]
    [string]$VerifyThreadId,

    [ValidateRange(30, 1800)]
    [int]$TurnTimeoutSeconds = 600,

    [ValidateRange(30, 300)]
    [int]$RestartTimeoutSeconds = 120,

    [switch]$SkipTurnWait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherRoot = $PSScriptRoot
$repositoryRoot = Split-Path -Parent $launcherRoot
$runtimeStatePath = Join-Path $launcherRoot 'state\current.json'
$syncResultPath = Join-Path $launcherRoot 'state\project-sync-last.json'
$maintenanceResultPath = Join-Path $launcherRoot 'state\project-repair-last.json'
$maintenanceLogPath = Join-Path $launcherRoot 'logs\project-repair-last.log'
$launcherExecutable = Join-Path $launcherRoot 'CodexSharedLauncher.exe'
$bridgeStopScript = Join-Path $repositoryRoot 'discord-bridge\Stop-DiscordBridge.ps1'
$bridgeStartScript = Join-Path $repositoryRoot 'discord-bridge\Start-DiscordBridge.ps1'
$bridgeStatusScript = Join-Path $repositoryRoot 'discord-bridge\Get-DiscordBridgeStatus.ps1'
$threadStatusScript = Join-Path $launcherRoot 'read-thread-status.mjs'
$bridgeWasStopped = $false

function Write-MaintenanceLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = '{0} {1}' -f ([DateTimeOffset]::Now.ToString('o')), $Message
    Add-Content -LiteralPath $maintenanceLogPath -Value $line -Encoding UTF8
}

function Write-MaintenanceResult {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Result)

    $temporaryPath = "$maintenanceResultPath.$PID.tmp"
    $Result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $maintenanceResultPath -Force
}

function Get-DesktopProcesses {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    $pattern = '^"?' + [regex]::Escape($DesktopExecutable) + '"?(?:\s|$)'
    @(
        Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern }
    )
}

function Get-DesktopRootProcesses {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    @(
        Get-DesktopProcesses -DesktopExecutable $DesktopExecutable |
            Where-Object { $_.CommandLine -notmatch '(?:^|\s)--type=' }
    )
}

function Test-ReadyEndpoint {
    param([Parameter(Mandatory)][string]$ReadyUrl)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $ReadyUrl -TimeoutSec 2
        $response.StatusCode -eq 200
    }
    catch {
        $false
    }
}

function Start-BridgeHidden {
    $scheduledTask = Get-ScheduledTask -TaskName 'Codex Discord Remote' -ErrorAction SilentlyContinue
    if ($null -ne $scheduledTask) {
        Start-ScheduledTask -TaskName 'Codex Discord Remote'
        return
    }

    $powerShellExecutable = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bridgeStartScript`""
    Start-Process -FilePath $powerShellExecutable -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

function Wait-ForCurrentTurn {
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $deadline = [DateTimeOffset]::Now.AddSeconds($TurnTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        $runtimeState = Get-Content -LiteralPath $runtimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $snapshotText = @(
            & $nodeExecutable $threadStatusScript `
                --endpoint $runtimeState.websocketUrl `
                --thread $WaitForThreadId 2>&1
        )
        if ($LASTEXITCODE -eq 0) {
            try {
                $snapshot = ($snapshotText -join [Environment]::NewLine) | ConvertFrom-Json
                if ($snapshot.status -ne 'active') {
                    Write-MaintenanceLog "Target turn completed. threadId=$WaitForThreadId status=$($snapshot.status)"
                    Start-Sleep -Seconds 5
                    return
                }
            }
            catch {
                Write-MaintenanceLog "Unable to parse target status; retrying. error=$($_.Exception.Message)"
            }
        }
        Start-Sleep -Seconds 1
    }
    throw "Target task remained active for $TurnTimeoutSeconds seconds: $WaitForThreadId"
}

function Assert-CurrentDesktopConnection {
    if (-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)) {
        throw "Shared launcher state is missing: $runtimeStatePath"
    }
    $state = Get-Content -LiteralPath $runtimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.websocketUrl -ne 'ws://127.0.0.1:8798') {
        throw "Unexpected app-server endpoint: $($state.websocketUrl)"
    }
    if ($state.desktopConnectionVerified -ne $true) {
        throw 'The current Desktop WebSocket connection is not verified.'
    }
    if (-not (Test-ReadyEndpoint -ReadyUrl $state.readyUrl)) {
        throw "The current app-server is not ready: $($state.readyUrl)"
    }
    $listener = Get-NetTCPConnection -LocalPort 8798 -State Listen -ErrorAction Stop |
        Select-Object -First 1
    if ([int]$listener.OwningProcess -ne [int]$state.serverProcessId) {
        throw "Port 8798 is owned by PID $($listener.OwningProcess), not recorded PID $($state.serverProcessId)."
    }
    $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverProcessId)"
    if ($null -eq $serverProcess -or $serverProcess.ExecutablePath -ne $state.serverExecutable) {
        throw 'The live app-server executable does not match launcher state.'
    }
    $desktopRoots = @(Get-DesktopRootProcesses -DesktopExecutable $state.desktopExecutable)
    if ($desktopRoots.Count -eq 0) {
        throw 'No current Codex Desktop root process was found.'
    }
    [pscustomobject]@{
        State = $state
        DesktopRoots = $desktopRoots
    }
}

function Request-DesktopClose {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    $roots = @(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable)
    $requested = 0
    foreach ($root in $roots) {
        $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
            if ($process.CloseMainWindow()) {
                $requested += 1
                Write-MaintenanceLog "Desktop close requested. pid=$($root.ProcessId)"
            }
        }
    }
    if ($requested -eq 0) {
        throw 'Codex Desktop had no closeable main window. No process termination was attempted.'
    }

    $deadline = [DateTimeOffset]::Now.AddSeconds(15)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (@(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable).Count -eq 0) {
            Write-MaintenanceLog 'Codex Desktop exited normally.'
            return
        }
        Start-Sleep -Milliseconds 500
    }

    $remainingRoots = @(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable)
    foreach ($root in $remainingRoots) {
        $liveRoot = Get-CimInstance Win32_Process -Filter "ProcessId=$($root.ProcessId)" -ErrorAction Stop
        if (
            $null -eq $liveRoot -or
            $liveRoot.ExecutablePath -ne $DesktopExecutable -or
            $liveRoot.CommandLine -match '(?:^|\s)--type='
        ) {
            throw "Desktop-only termination safety check failed for PID $($root.ProcessId)."
        }
    }

    Write-MaintenanceLog (
        'Desktop remained alive after the normal close request; applying the verified Desktop-only termination fallback. ' +
        "pid=$($remainingRoots.ProcessId -join ',')"
    )
    foreach ($root in $remainingRoots) {
        Stop-Process -Id $root.ProcessId -Force -ErrorAction Stop
    }

    $terminationDeadline = [DateTimeOffset]::Now.AddSeconds(8)
    while ([DateTimeOffset]::Now -lt $terminationDeadline) {
        if (@(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable).Count -eq 0) {
            Write-MaintenanceLog 'Verified Codex Desktop root process termination completed.'
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Verified Codex Desktop root processes did not terminate within 8 seconds.'
}

function Wait-ForReattachedDesktop {
    param(
        [Parameter(Mandatory)][int]$ExistingServerProcessId,
        [Parameter(Mandatory)][int[]]$PreviousDesktopRootProcessIds
    )

    $deadline = [DateTimeOffset]::Now.AddSeconds($RestartTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf) {
            try {
                $state = Get-Content -LiteralPath $runtimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
                $currentRoots = @(Get-DesktopRootProcesses -DesktopExecutable $state.desktopExecutable)
                $currentRootIds = @($currentRoots | ForEach-Object { [int]$_.ProcessId })
                $recordedDesktopIds = @($state.desktopProcessIds | ForEach-Object { [int]$_ })
                $hasNewRoot = @(
                    $currentRootIds | Where-Object { $PreviousDesktopRootProcessIds -notcontains $_ }
                ).Count -gt 0
                $hasRecordedRoot = @(
                    $currentRootIds | Where-Object { $recordedDesktopIds -contains $_ }
                ).Count -gt 0
                if (
                    [int]$state.serverProcessId -eq $ExistingServerProcessId -and
                    $state.desktopConnectionVerified -eq $true -and
                    (Test-ReadyEndpoint -ReadyUrl $state.readyUrl) -and
                    $hasNewRoot -and
                    $hasRecordedRoot
                ) {
                    Write-MaintenanceLog (
                        "Desktop reattached to existing app-server. serverPid=$($state.serverProcessId) " +
                        "desktopPid=$($currentRootIds -join ',')"
                    )
                    return $state
                }
            }
            catch {
                # The launcher writes runtime state atomically; retry transient read errors.
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Codex Desktop did not reattach to the existing app-server within $RestartTimeoutSeconds seconds."
}

function Wait-ForBridge {
    $deadline = [DateTimeOffset]::Now.AddSeconds(60)
    while ([DateTimeOffset]::Now -lt $deadline) {
        try {
            $status = (& $bridgeStatusScript -Json | ConvertFrom-Json)
            if (
                $status.ProcessAlive -eq $true -and
                $status.DiscordReady -eq $true -and
                $status.CodexConnected -eq $true -and
                $status.AppServerReady -eq $true
            ) {
                Write-MaintenanceLog "Discord Bridge verified. pid=$($status.Pid)"
                return $status
            }
        }
        catch {
            # Retry while the Bridge initializes.
        }
        Start-Sleep -Seconds 1
    }
    throw 'Discord Bridge did not return to a fully connected state within 60 seconds.'
}

function Assert-RepairedAssignment {
    param(
        [Parameter(Mandatory)][string]$ThreadId,
        [Parameter(Mandatory)][string]$WebSocketUrl
    )

    $codexStateRoot = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
    }
    else {
        [IO.Path]::GetFullPath($env:CODEX_HOME)
    }
    $globalStatePath = Join-Path $codexStateRoot '.codex-global-state.json'
    $bridgeStatePath = Join-Path $repositoryRoot 'discord-bridge\data\state.json'
    $syncScript = Join-Path $launcherRoot 'sync-desktop-projects.mjs'
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $verificationText = @(
        & $nodeExecutable $syncScript `
            --dry-run `
            --endpoint $WebSocketUrl `
            --global-state $globalStatePath `
            --bridge-state $bridgeStatePath `
            --verify-thread $ThreadId 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Target task assignment verification failed: $($verificationText -join [Environment]::NewLine)"
    }
    $verification = ($verificationText -join [Environment]::NewLine) | ConvertFrom-Json
    if ($verification.ok -ne $true -or $verification.changed -ne $false) {
        throw "Project reconciliation is not idempotent after restart: $($verificationText -join ' ')"
    }
    $verification.verifiedThread
}

New-Item -ItemType Directory -Path (Split-Path -Parent $maintenanceLogPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $maintenanceResultPath) -Force | Out-Null
Remove-Item -LiteralPath $maintenanceResultPath -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $maintenanceLogPath -Value '' -Encoding UTF8
Write-MaintenanceLog "Project repair orchestration started. waitThreadId=$WaitForThreadId verifyThreadId=$VerifyThreadId"

try {
    if ($SkipTurnWait) {
        Write-MaintenanceLog 'Current-turn wait explicitly skipped for an attached live repair.'
    }
    else {
        Wait-ForCurrentTurn
    }
    $current = Assert-CurrentDesktopConnection
    Write-MaintenanceLog "Current Desktop connection verified. serverPid=$($current.State.serverProcessId)"
    $previousDesktopRootProcessIds = @(
        $current.DesktopRoots | ForEach-Object { [int]$_.ProcessId }
    )

    & $bridgeStopScript -TimeoutSeconds 30 | ForEach-Object { Write-MaintenanceLog $_ }
    $bridgeWasStopped = $true

    Request-DesktopClose -DesktopExecutable $current.State.desktopExecutable

    Start-Process -FilePath $launcherExecutable -WindowStyle Hidden | Out-Null
    Write-MaintenanceLog 'Desktop-only launch on the existing app-server requested.'
    $restartedState = Wait-ForReattachedDesktop `
        -ExistingServerProcessId ([int]$current.State.serverProcessId) `
        -PreviousDesktopRootProcessIds $previousDesktopRootProcessIds

    if (-not (Test-Path -LiteralPath $syncResultPath -PathType Leaf)) {
        throw "Project sync result is missing: $syncResultPath"
    }
    $syncResult = Get-Content -LiteralPath $syncResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($syncResult.ok -ne $true) {
        throw "Project sync did not succeed: $($syncResult.error)"
    }
    $assignment = Assert-RepairedAssignment `
        -ThreadId $VerifyThreadId `
        -WebSocketUrl $restartedState.websocketUrl

    Start-BridgeHidden
    $bridgeStatus = Wait-ForBridge
    $bridgeWasStopped = $false

    $result = [ordered]@{
        ok = $true
        waitThreadId = $WaitForThreadId
        verifiedThreadId = $assignment.threadId
        projectId = $assignment.projectId
        projectName = $assignment.projectName
        cwd = $assignment.cwd
        serverProcessId = [int]$restartedState.serverProcessId
        desktopConnectionVerified = $restartedState.desktopConnectionVerified
        bridgeProcessId = [int]$bridgeStatus.Pid
        bridgeConnected = $bridgeStatus.CodexConnected
        sync = $syncResult
        completedAt = [DateTimeOffset]::Now.ToString('o')
        logPath = $maintenanceLogPath
    }
    Write-MaintenanceResult -Result $result
    Write-MaintenanceLog 'Project repair orchestration completed successfully.'
}
catch {
    $message = $_.Exception.Message
    Write-MaintenanceLog "ERROR $message"
    if ($bridgeWasStopped) {
        try {
            Start-BridgeHidden
            Write-MaintenanceLog 'Bridge restart requested during failure recovery.'
        }
        catch {
            Write-MaintenanceLog "Unable to restart Bridge during failure recovery: $($_.Exception.Message)"
        }
    }
    Write-MaintenanceResult -Result ([ordered]@{
        ok = $false
        waitThreadId = $WaitForThreadId
        verifyThreadId = $VerifyThreadId
        error = $message
        completedAt = [DateTimeOffset]::Now.ToString('o')
        logPath = $maintenanceLogPath
    })
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup(
            "Codex project repair failed.`n`n$message`n`nLog:`n$maintenanceLogPath",
            60,
            'Codex Shared Server',
            16
        )
    }
    catch {
        # The result and log files remain authoritative.
    }
    exit 1
}
