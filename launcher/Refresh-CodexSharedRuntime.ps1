[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f-]{36}$')]
    [string]$WaitForThreadId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f-]{36}$')]
    [string]$WaitForTurnId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]+(?:\.[0-9]+){1,3}$')]
    [string]$FromVersion,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]+(?:\.[0-9]+){1,3}$')]
    [string]$ToVersion,

    [ValidateRange(60, 3600)]
    [int]$TurnTimeoutSeconds = 1800,

    [ValidateRange(60, 600)]
    [int]$RestartTimeoutSeconds = 240,

    [ValidateRange(30, 600)]
    [int]$DesktopCloseTimeoutSeconds = 120,

    [switch]$ScheduledController,

    [ValidatePattern('^[0-9a-f-]{36}$')]
    [string]$RefreshRequestId,

    [ValidatePattern('^[A-Za-z0-9 ._-]+$')]
    [string]$ScheduledTaskName = 'Codex Shared Runtime Refresh'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherRoot = $PSScriptRoot
$repositoryRoot = Split-Path -Parent $launcherRoot
$runtimeStatePath = Join-Path $launcherRoot 'state\current.json'
$drainStatePath = Join-Path $launcherRoot 'state\package-update-drain.json'
$resultPath = Join-Path $launcherRoot 'state\runtime-refresh-last.json'
$logPath = Join-Path $launcherRoot 'logs\runtime-refresh-last.log'
$drainScript = Join-Path $launcherRoot 'runtime-update-drain.mjs'
$launcherExecutable = Join-Path $launcherRoot 'CodexSharedLauncher.exe'
$runtimeCacheScript = Join-Path $launcherRoot 'CodexRuntimeCache.ps1'
$controlScript = Join-Path $repositoryRoot 'control\codex-control.mjs'
$bridgeStopScript = Join-Path $repositoryRoot 'discord-bridge\Stop-DiscordBridge.ps1'
$bridgeStartScript = Join-Path $repositoryRoot 'discord-bridge\Start-DiscordBridge.ps1'
$bridgeStatusScript = Join-Path $repositoryRoot 'discord-bridge\Get-DiscordBridgeStatus.ps1'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$bridgeWasRunning = $false
$bridgeWasStopped = $false

if (-not (Test-Path -LiteralPath $runtimeCacheScript -PathType Leaf)) {
    throw "Codex runtime cache helper was not found: $runtimeCacheScript"
}
. $runtimeCacheScript

function Write-RefreshLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = '{0} {1}' -f ([DateTimeOffset]::Now.ToString('o')), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Write-RefreshResult {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Result)

    $temporaryPath = "$resultPath.$PID.tmp"
    $Result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $resultPath -Force
}

function Start-DetachedRefreshController {
    $existingTask = Get-ScheduledTask -TaskName $ScheduledTaskName -ErrorAction SilentlyContinue
    if ($null -ne $existingTask -and [string]$existingTask.State -eq 'Running') {
        throw "A shared runtime refresh controller is already running: $ScheduledTaskName"
    }
    if ($null -ne $existingTask) {
        Unregister-ScheduledTask -TaskName $ScheduledTaskName -Confirm:$false
    }

    $requestId = [Guid]::NewGuid().ToString()
    $escapedScriptPath = $PSCommandPath.Replace("'", "''")
    $controllerCommand = @"
& '$escapedScriptPath' `
    -WaitForThreadId '$WaitForThreadId' `
    -WaitForTurnId '$WaitForTurnId' `
    -FromVersion '$FromVersion' `
    -ToVersion '$ToVersion' `
    -TurnTimeoutSeconds $TurnTimeoutSeconds `
    -RestartTimeoutSeconds $RestartTimeoutSeconds `
    -DesktopCloseTimeoutSeconds $DesktopCloseTimeoutSeconds `
    -ScheduledController `
    -RefreshRequestId '$requestId' `
    -ScheduledTaskName '$ScheduledTaskName'
"@
    $encodedCommand = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes($controllerCommand)
    )
    $powerShellExecutable = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction `
        -Execute $powerShellExecutable `
        -Argument (
            '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass ' +
            "-WindowStyle Hidden -EncodedCommand $encodedCommand"
        ) `
        -WorkingDirectory $repositoryRoot
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable

    Register-ScheduledTask `
        -TaskName $ScheduledTaskName `
        -Action $action `
        -Principal $principal `
        -Settings $settings `
        -Description 'One-shot controller for a safe shared Codex runtime refresh.' `
        -Force | Out-Null
    Start-ScheduledTask -TaskName $ScheduledTaskName

    $deadline = [DateTimeOffset]::Now.AddSeconds(30)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
            try {
                $receipt = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if (
                    $receipt.requestId -eq $requestId -and
                    $receipt.controllerLaunchMode -eq 'scheduled-task' -and
                    [int]$receipt.controllerProcessId -ne $PID
                ) {
                    return [pscustomobject]@{
                        ok = $true
                        phase = 'detached-controller-started'
                        requestId = $requestId
                        controllerProcessId = [int]$receipt.controllerProcessId
                        scheduledTaskName = $ScheduledTaskName
                        receiptPath = $resultPath
                        logPath = $logPath
                    }
                }
            }
            catch {
                # The worker replaces the receipt atomically; retry transient reads.
            }
        }
        Start-Sleep -Milliseconds 250
    }

    throw (
        'Detached runtime refresh launch is uncertain because no matching armed receipt ' +
        "was observed within 30 seconds. Task=$ScheduledTaskName requestId=$requestId"
    )
}

function Invoke-DrainCommand {
    param([Parameter(Mandatory)][ValidateSet('pause-active', 'active', 'wait-turn')][string]$Command)

    $arguments = @($drainScript, $Command, '--endpoint', 'ws://127.0.0.1:8798')
    switch ($Command) {
        'pause-active' {
            $arguments += @(
                '--state', $drainStatePath,
                '--from-version', $FromVersion,
                '--to-version', $ToVersion
            )
        }
        'wait-turn' {
            $arguments += @(
                '--thread', $WaitForThreadId,
                '--turn', $WaitForTurnId,
                '--timeout-ms', ([string]($TurnTimeoutSeconds * 1000))
            )
        }
    }
    $output = @(& $nodeExecutable @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Runtime drain command failed ($Command): $($output -join [Environment]::NewLine)"
    }
    if ($output.Count -eq 0) {
        throw "Runtime drain command returned no output: $Command"
    }
    $output[-1] | ConvertFrom-Json
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
        (Invoke-WebRequest -UseBasicParsing -Uri $ReadyUrl -TimeoutSec 2).StatusCode -eq 200
    }
    catch {
        $false
    }
}

function Get-VerifiedRuntimeState {
    if (-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)) {
        throw "Shared runtime state is missing: $runtimeStatePath"
    }
    $state = Get-Content -LiteralPath $runtimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.websocketUrl -ne 'ws://127.0.0.1:8798') {
        throw "Unexpected shared endpoint: $($state.websocketUrl)"
    }
    $listener = @(Get-NetTCPConnection -LocalPort 8798 -State Listen -ErrorAction Stop)
    if ($listener.Count -ne 1 -or [int]$listener[0].OwningProcess -ne [int]$state.serverProcessId) {
        throw 'The shared listener owner does not match runtime state.'
    }
    $server = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverProcessId)" -ErrorAction Stop
    if ($null -eq $server -or $server.ExecutablePath -ne $state.serverExecutable) {
        throw 'The shared server executable does not match runtime state.'
    }
    if (-not (Test-ReadyEndpoint -ReadyUrl $state.readyUrl)) {
        throw 'The shared server ready endpoint is not healthy.'
    }
    $actualServerHash = Get-CodexFileSha256 -Path $state.serverExecutable
    if ($actualServerHash -ne $state.serverSha256) {
        throw 'The live shared server hash does not match runtime state.'
    }
    $state
}

function Wait-AllThreadsIdle {
    $idleChecks = 0
    $lastActiveSet = $null
    while ($idleChecks -lt 5) {
        $drain = Invoke-DrainCommand -Command 'pause-active'
        $activeThreadIds = @($drain.activeThreadIds)
        $activeSet = $activeThreadIds -join ','
        if ($activeSet -ne $lastActiveSet) {
            Write-RefreshLog "Active task set while draining: count=$($activeThreadIds.Count) ids=$activeSet"
            $lastActiveSet = $activeSet
        }
        if ($activeThreadIds.Count -eq 0) {
            $idleChecks += 1
        }
        else {
            $idleChecks = 0
        }
        if ($idleChecks -lt 5) {
            Start-Sleep -Seconds 1
        }
    }
}

function Request-DesktopClose {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    $roots = @(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable)
    $requested = 0
    foreach ($root in $roots) {
        $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.MainWindowHandle -ne [IntPtr]::Zero -and $process.CloseMainWindow()) {
            $requested += 1
            Write-RefreshLog "Desktop close requested. pid=$($root.ProcessId)"
        }
    }
    if ($requested -eq 0) {
        throw 'Codex Desktop had no closeable main window. No process termination was attempted.'
    }

    $deadline = [DateTimeOffset]::Now.AddSeconds($DesktopCloseTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (@(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable).Count -eq 0) {
            Write-RefreshLog 'Codex Desktop exited normally.'
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
    Write-RefreshLog (
        "Desktop remained alive after $DesktopCloseTimeoutSeconds seconds; " +
        "stopping verified roots. ids=$($remainingRoots.ProcessId -join ',')"
    )
    foreach ($root in $remainingRoots) {
        Stop-Process -Id $root.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $forcedDeadline = [DateTimeOffset]::Now.AddSeconds($RestartTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $forcedDeadline) {
        $stillRunning = @(
            foreach ($root in $remainingRoots) {
                $process = Get-CimInstance Win32_Process `
                    -Filter "ProcessId=$($root.ProcessId)" `
                    -ErrorAction SilentlyContinue
                if ($null -ne $process -and $process.ExecutablePath -eq $DesktopExecutable) {
                    $process
                }
            }
        )
        if ($stillRunning.Count -eq 0) {
            Write-RefreshLog 'Verified Desktop roots exited after the bounded stop request.'
            return
        }
        Start-Sleep -Milliseconds 500
    }

    throw "Verified Codex Desktop roots did not exit within $RestartTimeoutSeconds seconds."
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

function Wait-ForOldRuntimeExit {
    param(
        [Parameter(Mandatory)][int]$OldServerProcessId,
        [Parameter(Mandatory)][int]$OldSupervisorProcessId
    )

    $deadline = [DateTimeOffset]::Now.AddSeconds($RestartTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        $serverAlive = $null -ne (Get-Process -Id $OldServerProcessId -ErrorAction SilentlyContinue)
        $supervisorAlive = $null -ne (Get-Process -Id $OldSupervisorProcessId -ErrorAction SilentlyContinue)
        $listener = @(Get-NetTCPConnection -LocalPort 8798 -State Listen -ErrorAction SilentlyContinue)
        if (-not $serverAlive -and -not $supervisorAlive -and $listener.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'The old shared runtime did not exit within the restart timeout.'
}

function Wait-ForNewRuntime {
    param([Parameter(Mandatory)][int]$OldServerProcessId)

    $deadline = [DateTimeOffset]::Now.AddSeconds($RestartTimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        try {
            $state = Get-VerifiedRuntimeState
            if (
                [int]$state.serverProcessId -ne $OldServerProcessId -and
                $state.packageVersion -eq $ToVersion -and
                $state.desktopConnectionVerified -eq $true
            ) {
                $drain = Get-Content -LiteralPath $drainStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($drain.phase -eq 'completed' -and $drain.toVersion -eq $ToVersion) {
                    return $state
                }
            }
        }
        catch {
            # Runtime state changes atomically during startup; retry transient states.
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'The replacement shared runtime was not verified within the restart timeout.'
}

function Send-CompletionCallback {
    param([Parameter(Mandatory)][object]$NewState)

    $message = @"
Shared Codex runtime refresh completed with a fresh shared App Server.

from package: $FromVersion
to package: $ToVersion
new server PID: $($NewState.serverProcessId)
new server SHA-256: $($NewState.serverSha256)
receipt: $resultPath

The updater waited for all active turns, paused active goals before draining, and restored only goals paused by this update. Verify the receipt and continue the authorized ReasoningVM MVP-833 B5 workflow. Do not rerun the refresh merely because this callback arrived.
"@
    $output = @(
        & $nodeExecutable $controlScript deliver $WaitForThreadId `
            --url 'ws://127.0.0.1:8798' `
            --message $message `
            --compact 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Completion callback delivery failed or was uncertain: $($output -join [Environment]::NewLine)"
    }
    $delivery = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($delivery.accepted -ne $true -or $delivery.threadId -ne $WaitForThreadId) {
        throw "Completion callback was not positively accepted: $($output -join [Environment]::NewLine)"
    }
    $delivery
}

New-Item -ItemType Directory -Path (Split-Path -Parent $resultPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null

if (-not $ScheduledController) {
    Start-DetachedRefreshController | ConvertTo-Json -Depth 6
    return
}
if ([string]::IsNullOrWhiteSpace($RefreshRequestId)) {
    throw 'A scheduled refresh controller requires RefreshRequestId.'
}

Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $logPath -Value '' -Encoding UTF8
Write-RefreshResult -Result ([ordered]@{
    ok = $null
    phase = 'armed'
    requestId = $RefreshRequestId
    controllerLaunchMode = 'scheduled-task'
    scheduledTaskName = $ScheduledTaskName
    controllerProcessId = $PID
    threadId = $WaitForThreadId
    turnId = $WaitForTurnId
    fromVersion = $FromVersion
    toVersion = $ToVersion
    armedAt = [DateTimeOffset]::Now.ToString('o')
    logPath = $logPath
})
Write-RefreshLog "Runtime refresh armed. threadId=$WaitForThreadId turnId=$WaitForTurnId"

try {
    $oldState = Get-VerifiedRuntimeState
    if ($oldState.packageVersion -ne $FromVersion) {
        throw "Current shared server package version is $($oldState.packageVersion), not $FromVersion."
    }

    $null = Invoke-DrainCommand -Command 'pause-active'
    Write-RefreshLog 'Active goals were paused before the current-turn wait.'
    $turnResult = Invoke-DrainCommand -Command 'wait-turn'
    Write-RefreshLog "Exact source turn reached finite status. status=$($turnResult.status)"

    try {
        $bridgeStatus = (& $bridgeStatusScript -Json | ConvertFrom-Json)
        $bridgeWasRunning = $bridgeStatus.ProcessAlive -eq $true
    }
    catch {
        $bridgeWasRunning = $false
    }
    if ($bridgeWasRunning) {
        & $bridgeStopScript -TimeoutSeconds 30 | ForEach-Object { Write-RefreshLog $_ }
        $bridgeWasStopped = $true
    }

    Wait-AllThreadsIdle
    Write-RefreshLog 'All tasks remained idle for five consecutive checks.'
    Request-DesktopClose -DesktopExecutable $oldState.desktopExecutable
    Wait-ForOldRuntimeExit `
        -OldServerProcessId ([int]$oldState.serverProcessId) `
        -OldSupervisorProcessId ([int]$oldState.supervisorProcessId)
    Write-RefreshLog 'Old shared runtime exited under its owning supervisor.'

    Start-Process -FilePath $launcherExecutable -ArgumentList '--no-dialogs' -WindowStyle Hidden | Out-Null
    Write-RefreshLog 'Replacement shared launcher started.'
    $newState = Wait-ForNewRuntime -OldServerProcessId ([int]$oldState.serverProcessId)
    Write-RefreshLog "Replacement shared runtime verified. serverPid=$($newState.serverProcessId)"

    if ($bridgeWasRunning) {
        Start-BridgeHidden
        $bridgeStatus = Wait-ForBridge
        $bridgeWasStopped = $false
        Write-RefreshLog "Discord Bridge restored. pid=$($bridgeStatus.Pid)"
    }

    $pendingResult = [ordered]@{
        ok = $null
        phase = 'callback-pending'
        requestId = $RefreshRequestId
        controllerLaunchMode = 'scheduled-task'
        scheduledTaskName = $ScheduledTaskName
        controllerProcessId = $PID
        threadId = $WaitForThreadId
        turnId = $WaitForTurnId
        oldServerProcessId = [int]$oldState.serverProcessId
        newServerProcessId = [int]$newState.serverProcessId
        fromVersion = $FromVersion
        toVersion = $ToVersion
        serverSha256 = $newState.serverSha256
        desktopConnectionVerified = $newState.desktopConnectionVerified
        bridgeRestored = $bridgeWasRunning
        updatedAt = [DateTimeOffset]::Now.ToString('o')
        logPath = $logPath
    }
    Write-RefreshResult -Result $pendingResult
    $delivery = Send-CompletionCallback -NewState $newState

    $pendingResult.ok = $true
    $pendingResult.phase = 'completed'
    $pendingResult.callbackMode = $delivery.mode
    $pendingResult.callbackTurnId = $delivery.turnId
    $pendingResult.completedAt = [DateTimeOffset]::Now.ToString('o')
    Write-RefreshResult -Result $pendingResult
    Write-RefreshLog "Runtime refresh completed. callbackTurnId=$($delivery.turnId)"
}
catch {
    $message = $_.Exception.Message
    Write-RefreshLog "ERROR $message"
    if ($bridgeWasStopped) {
        try {
            Start-BridgeHidden
            Write-RefreshLog 'Bridge restart requested during failure recovery.'
        }
        catch {
            Write-RefreshLog "Bridge recovery failed: $($_.Exception.Message)"
        }
    }
    Write-RefreshResult -Result ([ordered]@{
        ok = $false
        phase = 'failed'
        requestId = $RefreshRequestId
        controllerLaunchMode = 'scheduled-task'
        scheduledTaskName = $ScheduledTaskName
        controllerProcessId = $PID
        threadId = $WaitForThreadId
        turnId = $WaitForTurnId
        fromVersion = $FromVersion
        toVersion = $ToVersion
        error = $message
        failedAt = [DateTimeOffset]::Now.ToString('o')
        logPath = $logPath
    })
    exit 1
}
