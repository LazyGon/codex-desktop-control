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

    [ValidateScript({ $_ -ge 0 })]
    [int]$TurnTimeoutSeconds = 0,

    [ValidateScript({ $_ -ge 0 })]
    [int]$RestartTimeoutSeconds = 0,

    [ValidateScript({ $_ -ge 0 })]
    [int]$DesktopCloseTimeoutSeconds = 0,

    [string]$PackagePath = '',
    [ValidatePattern('^(?:[0-9a-fA-F]{64})?$')]
    [string]$PackageSha256 = '',

    [switch]$RestartOnly,
    [switch]$CleanupExitedDesktopHelpers,
    [switch]$DesktopBrowserAccessTrial,

    # Requires explicit Owner approval for this update. Never stop dependency
    # packages or use a general process-kill fallback.
    [switch]$AllowTargetApplicationShutdown,

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
$resultPath = Join-Path $launcherRoot 'state\runtime-refresh-last.json'
$logPath = Join-Path $launcherRoot 'logs\runtime-refresh-last.log'
$drainScript = Join-Path $launcherRoot 'runtime-update-drain.mjs'
$runtimeCacheScript = Join-Path $launcherRoot 'CodexRuntimeCache.ps1'
$desktopShutdownScript = Join-Path $launcherRoot 'CodexDesktopShutdown.ps1'
$bridgeStatusScript = Join-Path $repositoryRoot 'discord-bridge\Get-DiscordBridgeStatus.ps1'
$refreshScriptPath = $PSCommandPath
$scheduledTaskDescription = 'One-shot controller for a safe shared Codex runtime refresh.'
$launchMutexName = 'Local\CodexSharedRuntimeRefreshLaunch'
$controllerMutexName = 'Local\CodexSharedRuntimeRefreshController'
. (Join-Path $launcherRoot 'CodexNodeRuntime.ps1')
$nodeExecutable = Get-CodexNodeExecutable -StateRoot (Split-Path -Parent $runtimeStatePath)
$bridgeWasRunning = $false

if (-not (Test-Path -LiteralPath $runtimeCacheScript -PathType Leaf)) {
    throw "Codex runtime cache helper was not found: $runtimeCacheScript"
}
. $runtimeCacheScript
. $desktopShutdownScript
. (Join-Path $launcherRoot 'CodexRuntimeHandoff.ps1')
. (Join-Path $launcherRoot 'CodexDesktopPackage.ps1')
. (Join-Path $launcherRoot 'CodexDesktopStartup.ps1')
. (Join-Path $launcherRoot 'CodexDesktopHelpers.ps1')

function Write-RefreshLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = '{0} {1}' -f ([DateTimeOffset]::Now.ToString('o')), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Write-RefreshResult {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Result)

    $temporaryPath = "$resultPath.$PID.tmp"
    $backupPath = "$resultPath.$PID.bak"
    try {
        $Result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
        if ([IO.File]::Exists($resultPath)) {
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
            [IO.File]::Replace($temporaryPath, $resultPath, $backupPath)
        }
        else {
            [IO.File]::Move($temporaryPath, $resultPath)
        }
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-OptionalObjectProperty {
    param(
        [Parameter(Mandatory)][object]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    $property.Value
}

function Enter-ExclusiveMutex {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$FailureMessage
    )

    $mutex = [Threading.Mutex]::new($false, $Name)
    $owned = $false
    try {
        try {
            $owned = $mutex.WaitOne(0)
        }
        catch [Threading.AbandonedMutexException] {
            $owned = $true
        }
        if (-not $owned) {
            throw $FailureMessage
        }
        $mutex
    }
    catch {
        if (-not $owned) {
            $mutex.Dispose()
        }
        throw
    }
}

function Exit-ExclusiveMutex {
    param([AllowNull()][Threading.Mutex]$Mutex)

    if ($null -eq $Mutex) {
        return
    }
    try {
        $Mutex.ReleaseMutex()
    }
    finally {
        $Mutex.Dispose()
    }
}

function Assert-OwnedRefreshTask {
    param([Parameter(Mandatory)][object]$Task)

    $actions = @($Task.Actions | Where-Object { $null -ne $_ })
    $triggers = @($Task.Triggers | Where-Object { $null -ne $_ })
    $expectedPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $expectedUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    try {
        $taskAccount = [Security.Principal.NTAccount]::new([string]$Task.Principal.UserId)
        $taskUserSid = $taskAccount.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    catch {
        throw (
            'The existing scheduled task principal could not be resolved. ' +
            "No task was changed: $ScheduledTaskName"
        )
    }
    $argumentMatch = [regex]::Match(
        [string]$actions[0].Arguments,
        '^-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden ' +
            '-EncodedCommand (?<payload>[A-Za-z0-9+/]+={0,2})$'
    )
    $controllerCommandMatches = $false
    if ($argumentMatch.Success) {
        try {
            $controllerCommand = [Text.Encoding]::Unicode.GetString(
                [Convert]::FromBase64String($argumentMatch.Groups['payload'].Value)
            )
            $normalizedControllerCommand = [regex]::Replace(
                $controllerCommand.Trim(),
                '\s*`\r?\n\s*',
                ' '
            )
            $normalizedControllerCommand = [regex]::Replace(
                $normalizedControllerCommand,
                '\s+',
                ' '
            )
            $escapedRefreshScript = $refreshScriptPath.Replace("'", "''")
            $controllerPattern = (
                "^& '$([regex]::Escape($escapedRefreshScript))' " +
                "-WaitForThreadId '[0-9a-f-]{36}' " +
                "-WaitForTurnId '[0-9a-f-]{36}' " +
                "-FromVersion '[0-9]+(?:\.[0-9]+){1,3}' " +
                "-ToVersion '[0-9]+(?:\.[0-9]+){1,3}' " +
                '-TurnTimeoutSeconds [0-9]+ ' +
                '-RestartTimeoutSeconds [0-9]+ ' +
                '-DesktopCloseTimeoutSeconds [0-9]+ ' +
                "(?:-PackagePath '(?:[^']|'')*' -PackageSha256 '(?:[A-Fa-f0-9]{64})?' )?" +
                '(?:-RestartOnly:\$(?:True|False) )?' +
                '(?:-CleanupExitedDesktopHelpers:\$(?:True|False) )?' +
                '(?:-DesktopBrowserAccessTrial:\$(?:True|False) )?' +
                '(?:-AllowTargetApplicationShutdown:\$(?:True|False) )?' +
                '-ScheduledController ' +
                "-RefreshRequestId '[0-9a-f-]{36}' " +
                "-ScheduledTaskName '$([regex]::Escape($ScheduledTaskName))'$"
            )
            $controllerCommandMatches = $normalizedControllerCommand -match $controllerPattern
        }
        catch {
            $controllerCommandMatches = $false
        }
    }
    if (
        [string]$Task.State -ne 'Ready' -or
        [string]$Task.Description -ne $scheduledTaskDescription -or
        $taskUserSid -ne $expectedUserSid -or
        $actions.Count -ne 1 -or
        [string]$actions[0].Execute -ne $expectedPowerShell -or
        [string]$actions[0].WorkingDirectory -ne $repositoryRoot -or
        -not $controllerCommandMatches -or
        $triggers.Count -ne 0
    ) {
        throw (
            'The existing scheduled task is not a replaceable stale refresh task. ' +
            "No task was changed: $ScheduledTaskName"
        )
    }
}

function Assert-NoUnresolvedRefreshReceipt {
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        return
    }
    try {
        $receipt = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw 'The existing runtime refresh receipt is unreadable. No task was changed.'
    }
    $requestId = Get-OptionalObjectProperty -InputObject $receipt -Name 'requestId'
    if ([string]::IsNullOrWhiteSpace([string]$requestId)) {
        # Receipts created before request-bound controllers are legacy evidence, not live ownership.
        return
    }
    if ($receipt.phase -notin @('completed', 'failed')) {
        throw (
            "Refresh request $requestId remains unresolved in phase $($receipt.phase). " +
            'No task or receipt was changed.'
        )
    }
}

function Wait-ForControllerAcceptance {
    while ($true) {
        try {
            $receipt = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (
                (Get-OptionalObjectProperty -InputObject $receipt -Name 'requestId') -ne $RefreshRequestId -or
                [int]$receipt.controllerProcessId -ne $PID
            ) {
                throw 'The refresh receipt was replaced before controller acceptance.'
            }
            if ($receipt.phase -eq 'controller-accepted') {
                if ($receipt.desktopBrowserAccessTrial -ne [bool]$DesktopBrowserAccessTrial) {
                    throw 'The accepted receipt does not match the requested Desktop browser access mode.'
                }
                return $receipt
            }
            if ($receipt.phase -ne 'armed') {
                throw "Unexpected refresh receipt phase before controller acceptance: $($receipt.phase)"
            }
        }
        catch [System.IO.IOException] {
            # Retry a transient read while the entry process atomically acknowledges the receipt.
        }
        Start-Sleep -Milliseconds 250
    }

}

function New-RefreshControllerCommand {
    param([Parameter(Mandatory)][string]$RequestId)

    $escapedScriptPath = $refreshScriptPath.Replace("'", "''")
    $escapedPackagePath = $PackagePath.Replace("'", "''")
    @(
        "& '$escapedScriptPath'",
        "-WaitForThreadId '$WaitForThreadId'",
        "-WaitForTurnId '$WaitForTurnId'",
        "-FromVersion '$FromVersion'",
        "-ToVersion '$ToVersion'",
        "-TurnTimeoutSeconds $TurnTimeoutSeconds",
        "-RestartTimeoutSeconds $RestartTimeoutSeconds",
        "-DesktopCloseTimeoutSeconds $DesktopCloseTimeoutSeconds",
        "-PackagePath '$escapedPackagePath' -PackageSha256 '$PackageSha256'",
        "-RestartOnly:`$$([bool]$RestartOnly)",
        "-CleanupExitedDesktopHelpers:`$$([bool]$CleanupExitedDesktopHelpers)",
        "-DesktopBrowserAccessTrial:`$$([bool]$DesktopBrowserAccessTrial)",
        "-AllowTargetApplicationShutdown:`$$([bool]$AllowTargetApplicationShutdown)",
        '-ScheduledController',
        "-RefreshRequestId '$RequestId'",
        "-ScheduledTaskName '$ScheduledTaskName'"
    ) -join ' '
}

function Start-DetachedRefreshController {
    $launchMutex = Enter-ExclusiveMutex `
        -Name $launchMutexName `
        -FailureMessage 'Another shared runtime refresh launch is already being admitted.'
    try {
        $controllerProbe = Enter-ExclusiveMutex `
            -Name $controllerMutexName `
            -FailureMessage 'A shared runtime refresh controller is already running.'
        Exit-ExclusiveMutex -Mutex $controllerProbe

        Assert-NoUnresolvedRefreshReceipt

        $existingTask = Get-ScheduledTask -TaskName $ScheduledTaskName -ErrorAction SilentlyContinue
        if ($null -ne $existingTask -and [string]$existingTask.State -eq 'Running') {
            throw "A shared runtime refresh controller is already running: $ScheduledTaskName"
        }
        if ($null -ne $existingTask) {
            Assert-OwnedRefreshTask -Task $existingTask
            Unregister-ScheduledTask -TaskName $ScheduledTaskName -Confirm:$false
            if ($null -ne (Get-ScheduledTask -TaskName $ScheduledTaskName -ErrorAction SilentlyContinue)) {
                throw "The stale refresh task could not be removed: $ScheduledTaskName"
            }
        }

        $requestId = [Guid]::NewGuid().ToString()
        $controllerCommand = New-RefreshControllerCommand -RequestId $requestId
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
            -Description $scheduledTaskDescription `
            -Force | Out-Null
        Start-ScheduledTask -TaskName $ScheduledTaskName

        while ($true) {
            $receipt = $null
            if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
                try {
                    $receipt = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
                }
                catch {
                    # The controller replaces the receipt atomically; retry transient reads.
                }
            }
            if (
                $null -ne $receipt -and
                (Get-OptionalObjectProperty -InputObject $receipt -Name 'requestId') -eq $requestId
            ) {
                if (
                    $receipt.phase -eq 'armed' -and
                    $receipt.controllerLaunchMode -eq 'scheduled-task' -and
                    [int]$receipt.controllerProcessId -ne $PID -and
                    $receipt.threadId -eq $WaitForThreadId -and
                    $receipt.turnId -eq $WaitForTurnId -and
                    $receipt.fromVersion -eq $FromVersion -and
                    $receipt.toVersion -eq $ToVersion -and
                    $receipt.restartOnly -eq [bool]$RestartOnly -and
                    $receipt.cleanupExitedDesktopHelpers -eq [bool]$CleanupExitedDesktopHelpers -and
                    $receipt.desktopBrowserAccessTrial -eq [bool]$DesktopBrowserAccessTrial -and
                    $receipt.allowTargetApplicationShutdown -eq [bool]$AllowTargetApplicationShutdown
                ) {
                    $acceptedAt = [DateTimeOffset]::Now.ToString('o')
                    Write-RefreshResult -Result ([ordered]@{
                        ok = $null
                        phase = 'controller-accepted'
                        requestId = $requestId
                        controllerLaunchMode = 'scheduled-task'
                        scheduledTaskName = $ScheduledTaskName
                        controllerProcessId = [int]$receipt.controllerProcessId
                        threadId = $WaitForThreadId
                        turnId = $WaitForTurnId
                        fromVersion = $FromVersion
                        toVersion = $ToVersion
                        restartOnly = [bool]$RestartOnly
                        cleanupExitedDesktopHelpers = [bool]$CleanupExitedDesktopHelpers
                        desktopBrowserAccessTrial = [bool]$DesktopBrowserAccessTrial
                        allowTargetApplicationShutdown = [bool]$AllowTargetApplicationShutdown
                        armedAt = $receipt.armedAt
                        controllerAcceptedAt = $acceptedAt
                        logPath = $logPath
                    })
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
                if ($receipt.phase -eq 'failed') {
                    throw "Detached runtime refresh controller failed before acceptance: $($receipt.error)"
                }
            }
            $liveTask = Get-ScheduledTask -TaskName $ScheduledTaskName -ErrorAction Stop
            if ([string]$liveTask.State -ne 'Running') {
                throw "Refresh controller exited without an armed receipt. requestId=$requestId"
            }
            Start-Sleep -Milliseconds 250
        }

    }
    finally {
        Exit-ExclusiveMutex -Mutex $launchMutex
    }
}

function Invoke-DrainCommand {
    param([Parameter(Mandatory)][ValidateSet('active', 'wait-turn', 'goal')][string]$Command)

    $arguments = @($drainScript, $Command, '--endpoint', 'ws://127.0.0.1:8798')
    switch ($Command) {
        'goal' { $arguments += @('--thread', $WaitForThreadId) }
        'wait-turn' {
            $arguments += @(
                '--thread', $WaitForThreadId,
                '--turn', $WaitForTurnId,
                '--timeout-ms', $(if ($TurnTimeoutSeconds -eq 0) { 'none' } else { [string]([long]$TurnTimeoutSeconds * 1000) })
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

function Test-DesktopWebSocketConnection {
    param(
        [Parameter(Mandatory)][string]$DesktopExecutable,
        [Parameter(Mandatory)][int]$PortNumber
    )

    $desktopProcessIds = @(
        Get-DesktopProcesses -DesktopExecutable $DesktopExecutable |
            ForEach-Object { [int]$_.ProcessId }
    )
    if ($desktopProcessIds.Count -eq 0) {
        return $false
    }
    $connections = @(
        Get-NetTCPConnection -State Established -RemotePort $PortNumber -ErrorAction SilentlyContinue |
            Where-Object {
                $_.RemoteAddress -in @('127.0.0.1', '::ffff:127.0.0.1', '::1') -and
                $desktopProcessIds -contains [int]$_.OwningProcess
            }
    )
    $connections.Count -gt 0
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
    if (
        $state.websocketUrl -ne 'ws://127.0.0.1:8798' -or
        $state.readyUrl -ne 'http://127.0.0.1:8798/readyz'
    ) {
        throw "Unexpected shared endpoint: $($state.websocketUrl)"
    }
    $listener = @(Get-NetTCPConnection -LocalPort 8798 -State Listen -ErrorAction Stop)
    if (
        $listener.Count -ne 1 -or
        $listener[0].LocalAddress -ne '127.0.0.1' -or
        [int]$listener[0].OwningProcess -ne [int]$state.serverProcessId
    ) {
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
    if (
        $state.desktopConnectionVerified -ne $true -or
        -not (Test-DesktopWebSocketConnection `
            -DesktopExecutable $state.desktopExecutable `
            -PortNumber 8798)
    ) {
        throw 'The current Desktop connection to the shared app-server was not verified.'
    }
    $state
}

function Wait-AllThreadsIdle {
    while ($true) {
        $activity = Invoke-DrainCommand -Command 'active'
        if ($activity.idle -eq $true) { return }
        Start-Sleep -Seconds 1
    }
}

function Request-DesktopClose {
    param([Parameter(Mandatory)][string]$DesktopExecutable, [object]$ExpectedRootActor)

    $roots = @(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable)
    if ($roots.Count -eq 0) { return }
    if ($roots.Count -ne 1) { throw 'More than one Desktop root was found. No shutdown was requested.' }
    foreach ($root in $roots) {
        $process = Get-Process -Id $root.ProcessId -ErrorAction Stop
        if ($ExpectedRootActor -and ($process.Id -ne $ExpectedRootActor.pid -or
            $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $ExpectedRootActor.startedUtcTicks -or
            $process.Path -ne $ExpectedRootActor.executable)) {
            throw 'Desktop root changed after capturing helpers; no shutdown was requested.'
        }
        $startedAt = $process.StartTime.ToUniversalTime().ToString('o')
        Write-RefreshLog "Normal Desktop application shutdown requested. pid=$($process.Id) method=RestartManager"
        $shutdown = Invoke-CodexDesktopNormalShutdown -ProcessId $process.Id `
            -ExpectedExecutable $DesktopExecutable -ExpectedStartTimeUtc $startedAt -Execute
        if (-not $shutdown.ShutdownRequested -or $shutdown.ReturnCode -ne 0 -or
            @($shutdown.AffectedProcessIds).Count -ne 1 -or
            $shutdown.AffectedProcessIds[0] -ne $process.Id) {
            throw "Normal Desktop shutdown was not confirmed. code=$($shutdown.ReturnCode). No forced close or retry was attempted."
        }
        Write-RefreshLog "Normal Desktop shutdown accepted. pid=$($process.Id)"
    }

    $deadline = if ($DesktopCloseTimeoutSeconds -eq 0) { [DateTimeOffset]::MaxValue } else { [DateTimeOffset]::Now.AddSeconds($DesktopCloseTimeoutSeconds) }
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (@(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable).Count -eq 0) {
            Write-RefreshLog 'Codex Desktop exited normally.'
            return
        }
        Start-Sleep -Milliseconds 500
    }

    throw 'Desktop did not exit normally within the explicitly supplied observation limit. No process was terminated.'
}

function Wait-ForOldRuntimeExit {
    param(
        [Diagnostics.Process]$Server,
        [Diagnostics.Process]$Supervisor,
        [Parameter(Mandatory)][string]$DesktopExecutable,
        [switch]$AllowLegacyExit
    )
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $Server.HasExited -or -not $Supervisor.HasExited -or (Get-CodexHandoffDesktopProcesses)) {
        # Request-DesktopClose has already verified that the admitted Desktop
        # root exited. A root appearing now belongs to a separate launch, not
        # to this request. Do not wait indefinitely or close that new Desktop.
        if (@(Get-DesktopRootProcesses -DesktopExecutable $DesktopExecutable).Count -gt 0) {
            throw 'Desktop reopened while the old AppServer was still releasing. This request will not close or replace the reopened Desktop.'
        }
        if ($RestartTimeoutSeconds -gt 0 -and $watch.Elapsed.TotalSeconds -ge $RestartTimeoutSeconds) {
            throw 'The old runtime did not release normally within the supplied observation limit.'
        }
        Start-Sleep -Milliseconds 500
    }
    Write-RefreshLog "Old runtime exit observed. serverExit=$($Server.ExitCode) supervisorExit=$($Supervisor.ExitCode) ownerApprovedLegacyUpdate=$([bool]$AllowLegacyExit)"
    if (($Server.ExitCode -ne 0 -or $Supervisor.ExitCode -ne 0) -and -not $AllowLegacyExit) {
        throw 'The old runtime did not exit cleanly; no install or launch was attempted.'
    }
}

function New-DesktopPackageInstallParameters {
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowTargetApplicationShutdown)

    $parameters = @{ Path = $Path; ErrorAction = 'Stop' }
    if ($AllowTargetApplicationShutdown) {
        $parameters.ForceTargetApplicationShutdown = $true
    }
    else { $parameters.DeferRegistrationWhenPackagesAreInUse = $true }
    $parameters
}

function Assert-OfficialUpdateArtifact {
    param([object]$Registered)
    if ($PackageSha256 -notmatch '^[0-9a-fA-F]{64}$' -or
        (Get-CodexFileSha256 -Path $PackagePath) -ne $PackageSha256 -or
        (Get-AuthenticodeSignature -LiteralPath $PackagePath).Status -ne 'Valid') {
        throw 'The supplied update package hash and signature were not verified.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
        $entry = $archive.GetEntry('AppxManifest.xml')
        if (-not $entry) { throw 'The signed update is not a Desktop MSIX package.' }
        $reader = [IO.StreamReader]::new($entry.Open())
        try { $manifest = [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
        $identity = $manifest.Package.Identity
        if ($identity.Name -ne $Registered.Name -or $identity.Publisher -ne $Registered.Publisher -or
            $identity.Version -ne $ToVersion -or $identity.ProcessorArchitecture -ne [string]$Registered.Architecture) {
            throw 'The update manifest does not match the registered package identity, architecture, and requested version.'
        }
    }
    finally { $archive.Dispose() }
}

function Complete-RegisteredRefresh {
    param([string]$Directory, [object]$Package, [object]$OldRuntime, [object]$OldServer, [object]$OldSupervisor)
    $handoffPath = Join-Path $Directory 'request.json'
    if (Test-Path -LiteralPath $handoffPath) { throw 'The replacement request already exists; inspect its receipt.' }
    Write-CodexHandoffJson $handoffPath @{
        id = $RefreshRequestId; port = $OldRuntime.port; fromVersion = $FromVersion; toVersion = $Package.Version
        desktop = $Package.DesktopExecutable; family = $Package.PackageFamilyName
        serverSha256 = Get-CodexFileSha256 $Package.BundledServerExecutable
        oldServer = $OldServer; oldSupervisor = $OldSupervisor; bridgeWasRunning = $bridgeWasRunning
        desktopBrowserAccessTrial = [bool]$DesktopBrowserAccessTrial
        ownerApprovedLegacyUpdate = [bool]$legacyUpdate
        startupStallSeconds = $RestartTimeoutSeconds
    }
    & (Join-Path $launcherRoot 'Complete-CodexRuntimeHandoff.ps1') -RequestPath $handoffPath
    $handoff = Read-CodexHandoffJson (Join-Path $Directory 'result.json')
    if ($handoff.phase -ne 'verified') { throw "Replacement verification is incomplete: $($handoff.detail)" }
    Get-VerifiedRuntimeState
}

function Send-CompletionCallback {
    param([object]$NewState = $null, [string]$FailureMessage = '')

    $callbackState = if ($NewState) { $NewState } else { Get-VerifiedRuntimeState }
    $resultDetails = if ($FailureMessage) { "Refresh failed: $FailureMessage" } else {
        "new server PID: $($NewState.serverProcessId)`nnew server SHA-256: $($NewState.serverSha256)"
    }
    $operation = if ($DesktopBrowserAccessTrial) { 'same-version restart for the Desktop browser access trial' }
        elseif ($RestartOnly) { 'same-version restart' } else { 'package update' }
    $goalPausePath = Join-Path (Split-Path -Parent $resultPath) "runtime-refresh-history/$RefreshRequestId-goal-pause.json"
    $message = @"
Shared Codex runtime refresh settled. Verify the receipt before claiming success.

from package: $FromVersion
to package: $ToVersion
operation: $operation
request id: $RefreshRequestId
$resultDetails
receipt: $resultPath

Verify the receipt, installed package, shared Desktop connection and Discord Bridge, then report the requested operation's result. Do not rerun an uncertain operation merely because this callback arrived. No Windows restart or credit policy activation was authorized.
If the exact waiter-owned goal pause receipt exists at $goalPausePath, verify it and the current goal identity and paused revision, then resume that same goal once using the supported shared App Server before continuing goal work. Do not undo a later manual pause, changed goal or terminal state.
"@
    $output = @(
        & $nodeExecutable $drainScript deliver --thread $WaitForThreadId `
            --endpoint $callbackState.websocketUrl --server-pid ([string]$callbackState.serverProcessId) `
            --request-id $RefreshRequestId `
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

function Assert-RefreshMode {
    if ($DesktopBrowserAccessTrial) {
        if (-not $RestartOnly) { throw 'The Desktop browser access trial requires a same-version restart.' }
        Assert-CodexDesktopBrowserAccessTrialVersion $FromVersion
        Assert-CodexDesktopBrowserAccessTrialVersion $ToVersion
    }
    if ($CleanupExitedDesktopHelpers -and -not $RestartOnly) {
        throw 'Opt-in residual helper cleanup applies only to a same-version restart.'
    }
    if ($RestartOnly) {
        if ($FromVersion -ne $ToVersion -or $PackagePath -or $PackageSha256 -or $AllowTargetApplicationShutdown) {
            throw 'Restart-only requires the same exact version and disallows installation inputs and forced shutdown.'
        }
    }
    elseif ([version]$ToVersion -le [version]$FromVersion) {
        throw 'The update target must be newer. For a same-version restart, select RestartOnly explicitly.'
    }
}

Assert-RefreshMode
New-Item -ItemType Directory -Path (Split-Path -Parent $resultPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null

if (-not $ScheduledController) {
    Start-DetachedRefreshController | ConvertTo-Json -Depth 6
    return
}
if ([string]::IsNullOrWhiteSpace($RefreshRequestId)) {
    throw 'A scheduled refresh controller requires RefreshRequestId.'
}

$controllerMutex = Enter-ExclusiveMutex `
    -Name $controllerMutexName `
    -FailureMessage 'Another shared runtime refresh controller already owns the operation.'
$controllerExitCode = 0
$callbackAttempted = $false
try {
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        try {
            $existingReceipt = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
        }
        catch {
            throw 'The existing runtime refresh receipt is unreadable. No receipt was replaced.'
        }
        if (
            (Get-OptionalObjectProperty -InputObject $existingReceipt -Name 'requestId') -eq
                $RefreshRequestId
        ) {
            throw "Refresh request $RefreshRequestId has already started. Its receipt was preserved."
        }
    }

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
        restartOnly = [bool]$RestartOnly
        cleanupExitedDesktopHelpers = [bool]$CleanupExitedDesktopHelpers
        desktopBrowserAccessTrial = [bool]$DesktopBrowserAccessTrial
        allowTargetApplicationShutdown = [bool]$AllowTargetApplicationShutdown
        armedAt = [DateTimeOffset]::Now.ToString('o')
        logPath = $logPath
    })
    Write-RefreshLog "Runtime refresh armed. threadId=$WaitForThreadId turnId=$WaitForTurnId"

    $directory = $null
    $oldExitVerified = $false
    $legacyUpdate = $false
    try {
        $null = Wait-ForControllerAcceptance
        Write-RefreshLog 'Detached controller receipt was positively acknowledged by the entry process.'

        $oldState = Get-VerifiedRuntimeState
        if ($oldState.packageVersion -ne $FromVersion) {
            throw "Current shared server package version is $($oldState.packageVersion), not $FromVersion."
        }

        if ((Get-OptionalObjectProperty $oldState 'appServerGracefulShutdown') -ne $true) {
            if ($RestartOnly) { throw 'The running AppServer does not support a verified normal shutdown.' }
            if (-not $AllowTargetApplicationShutdown -or -not $PackagePath) {
                throw 'The legacy runtime requires an official update artifact and explicit Owner approval for package-targeted shutdown.'
            }
            $legacyUpdate = $true
            Write-RefreshLog 'Owner-approved legacy migration: wait for loaded work to become idle, then let the existing supervisor release its own runtime.'
        }
        $installed = Get-AppxPackage -Name OpenAI.Codex
        if ($PackagePath) { Assert-OfficialUpdateArtifact $installed }
        elseif ([string]$installed.Version -ne $ToVersion) {
            throw 'Register the target Desktop package first or supply the signed update artifact.'
        }

        $turnResult = Invoke-DrainCommand -Command 'wait-turn'
        Write-RefreshLog "Exact source turn reached finite status. status=$($turnResult.status)"
        if ($CleanupExitedDesktopHelpers) {
            $goal = Invoke-DrainCommand -Command 'goal'
            $goalPausePath = Join-Path (Split-Path -Parent $resultPath) "runtime-refresh-history/$RefreshRequestId-goal-pause.json"
            $pause = Read-CodexHandoffJson $goalPausePath
            if (($goal.status -eq 'active' -or $pause) -and (-not $pause -or
                $pause.phase -ne 'waiter-paused' -or $pause.requestId -ne $RefreshRequestId -or
                $pause.threadId -ne $WaitForThreadId -or $pause.sourceTurnId -ne $WaitForTurnId -or
                $pause.goalIdentity -ne $goal.identity -or $pause.pausedUpdatedAt -ne $goal.updatedAt -or $goal.status -ne 'paused')) {
                throw 'The waiter-owned goal pause could not be verified; no shutdown was requested.'
            }
        }
        $bridgeWasRunning = (& $bridgeStatusScript -Json | ConvertFrom-Json).ProcessAlive -eq $true
        $live = Get-VerifiedRuntimeState
        if ($live.serverProcessId -ne $oldState.serverProcessId -or $live.supervisorProcessId -ne $oldState.supervisorProcessId) {
            throw 'The verified runtime changed while waiting.'
        }
        $server = Get-Process -Id $live.serverProcessId
        $supervisor = Get-Process -Id $live.supervisorProcessId
        $null = $server.Handle
        $null = $supervisor.Handle
        $oldServer = Get-CodexHandoffActor $server
        $oldSupervisor = Get-CodexHandoffActor $supervisor
        $directory = Join-Path (Join-Path $launcherRoot 'state/runtime-handoffs') $RefreshRequestId
        $null = New-Item -ItemType Directory -Path $directory
        $drainPath = Join-Path $directory 'drain.json'
        Wait-AllThreadsIdle
        $current = Read-CodexHandoffJson $runtimeStatePath
        if ($server.HasExited -or $supervisor.HasExited -or -not $current -or
            $current.serverProcessId -ne $server.Id -or $current.supervisorProcessId -ne $supervisor.Id) {
            throw 'The admitted runtime changed before Desktop shutdown.'
        }
        $rootActor = $null
        if ($CleanupExitedDesktopHelpers) {
            $roots = @(Get-DesktopRootProcesses -DesktopExecutable $oldState.desktopExecutable)
            if ($roots.Count -ne 1) { throw 'Expected one exact Desktop root before capturing residual helpers.' }
            $root = Get-Process -Id $roots[0].ProcessId
            $null = $root.Handle
            if ($root.Path -ne $oldState.desktopExecutable -or $root.HasExited) { throw 'The admitted Desktop root changed.' }
            $rootActor = Get-CodexHandoffActor $root
            $helpers = @(Select-CodexDesktopHelperCandidates $roots[0] @(Get-DesktopProcesses $oldState.desktopExecutable))
            $helperIds = @($helpers | ForEach-Object pid)
            $unknown = @(Get-CodexHandoffDesktopProcesses | Where-Object { $_.Id -ne $root.Id -and $_.Id -notin $helperIds })
            if ($unknown.Count -gt 0) { throw 'Unrelated or unverified Desktop processes are present; no shutdown was requested.' }
        }
        Write-CodexHandoffJson $drainPath @{ phase = 'desktop-close-requested' }
        Request-DesktopClose -DesktopExecutable $oldState.desktopExecutable -ExpectedRootActor $rootActor
        if ($CleanupExitedDesktopHelpers) {
            if (-not $root.HasExited -or @(Get-DesktopRootProcesses -DesktopExecutable $oldState.desktopExecutable).Count) {
                throw 'Desktop exit was not confirmed for the recorded helper cohort.'
            }
            $null = Stop-CodexExitedDesktopHelpers $rootActor $helpers (Join-Path $directory 'helper-cleanup.json')
            if (Get-CodexHandoffDesktopProcesses) { throw 'Unverified Desktop processes remain after cleanup; no additional process was terminated.' }
        }
        Wait-ForOldRuntimeExit $server $supervisor -DesktopExecutable $oldState.desktopExecutable -AllowLegacyExit:$legacyUpdate
        Write-CodexHandoffJson $drainPath @{ phase = 'exited'; exitCode = $server.ExitCode; supervisorExitCode = $supervisor.ExitCode; ownerApprovedLegacyUpdate = $legacyUpdate }
        $oldExitVerified = $true
        Write-RefreshLog 'Old shared runtime exited under its owning supervisor.'

        $installed = Get-AppxPackage -Name OpenAI.Codex
        if ($PackagePath -and [string]$installed.Version -ne $ToVersion) {
            if ([string]$installed.Version -ne $FromVersion -or $installed.PackageFamilyName -ne $oldState.packageFamilyName -or
                (Get-CodexFileSha256 -Path $PackagePath) -ne $PackageSha256 -or (Get-CodexHandoffDesktopProcesses)) {
                throw 'Package or process state changed after preflight; no installation was attempted.'
            }
            $installReceipt = Join-Path $directory 'install.json'
            Write-CodexHandoffJson $installReceipt @{ phase = 'requested'; toVersion = $ToVersion; packageSha256 = $PackageSha256; allowTargetApplicationShutdown = [bool]$AllowTargetApplicationShutdown }
            $installParameters = New-DesktopPackageInstallParameters -Path $PackagePath `
                -AllowTargetApplicationShutdown:$AllowTargetApplicationShutdown
            if ($AllowTargetApplicationShutdown) {
                Write-RefreshLog 'Owner-approved package-targeted shutdown enabled for installation; dependency packages are excluded.'
            }
            $packageRoot = Split-Path -Parent (Split-Path -Parent $oldState.desktopExecutable)
            $remaining = @(Get-CimInstance Win32_Process | Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.StartsWith(
                    "$packageRoot\", [StringComparison]::OrdinalIgnoreCase)
            })
            $remainingIds = @($remaining | ForEach-Object { [int]$_.ProcessId })
            Write-RefreshLog "Package processes before installation: count=$($remaining.Count) ids=$($remainingIds -join ',')"
            if ($remaining.Count -gt 0 -and -not $AllowTargetApplicationShutdown) {
                throw 'Old package processes remain after normal shutdown. No forced shutdown was authorized or attempted.'
            }
            Add-AppxPackage @installParameters
            $installed = Get-AppxPackage -Name OpenAI.Codex
            Write-CodexHandoffJson $installReceipt @{ phase = 'observed'; registeredVersion = [string]$installed.Version }
        }
        $package = Get-CodexDesktopPackageInfo -RequireBundledRuntime -RequireTrustedRegistration
        if ($package.Version -ne $ToVersion -or $package.PackageFamilyName -ne $oldState.packageFamilyName) {
            throw 'The requested version is not registered. Inspect Windows package state before any other action.'
        }
        $newState = Complete-RegisteredRefresh $directory $package $oldState $oldServer $oldSupervisor
        Write-RefreshLog "Replacement shared runtime verified. serverPid=$($newState.serverProcessId)"

        $pendingResult = [ordered]@{
            ok = $null
            phase = 'callback-pending'
            callbackStatus = 'dispatching'
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
            restartOnly = [bool]$RestartOnly
            cleanupExitedDesktopHelpers = [bool]$CleanupExitedDesktopHelpers
            desktopBrowserAccessTrial = [bool]$DesktopBrowserAccessTrial
            allowTargetApplicationShutdown = [bool]$AllowTargetApplicationShutdown
            serverSha256 = $newState.serverSha256
            desktopConnectionVerified = $newState.desktopConnectionVerified
            bridgeRestored = $bridgeWasRunning
            updatedAt = [DateTimeOffset]::Now.ToString('o')
            logPath = $logPath
        }
        Write-RefreshResult -Result $pendingResult
        $callbackAttempted = $true
        $delivery = Send-CompletionCallback -NewState $newState

        $pendingResult.ok = $true
        $pendingResult.phase = 'completed'
        $pendingResult.callbackStatus = 'accepted'
        $pendingResult.callbackMode = $delivery.mode
        $pendingResult.callbackTurnId = $delivery.turnId
        $pendingResult.completedAt = [DateTimeOffset]::Now.ToString('o')
        Write-RefreshResult -Result $pendingResult
        Write-RefreshLog "Runtime refresh completed. callbackTurnId=$($delivery.turnId)"
    }
    catch {
        $message = $_.Exception.Message
        Write-RefreshLog "ERROR $message"
        $recoveredVersion = $null
        if ($oldExitVerified -and -not (Test-Path -LiteralPath (Join-Path $directory 'request.json'))) {
            try {
                # Registration may have changed despite a deployment error. Read it;
                # never repeat Add-AppxPackage or start a second replacement.
                $actual = Get-CodexDesktopPackageInfo -RequireBundledRuntime -RequireTrustedRegistration
                if ($actual.PackageFamilyName -eq $oldState.packageFamilyName -and $actual.Version -in @($FromVersion, $ToVersion)) {
                    $recovered = Complete-RegisteredRefresh $directory $actual $oldState $oldServer $oldSupervisor
                    $recoveredVersion = $recovered.packageVersion
                    $message += " Shared runtime recovered on registered version $recoveredVersion."
                }
            }
            catch { Write-RefreshLog "Registered runtime recovery could not be verified: $($_.Exception.Message)" }
        }
        $failureResult = [ordered]@{
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
            restartOnly = [bool]$RestartOnly
            cleanupExitedDesktopHelpers = [bool]$CleanupExitedDesktopHelpers
            desktopBrowserAccessTrial = [bool]$DesktopBrowserAccessTrial
            allowTargetApplicationShutdown = [bool]$AllowTargetApplicationShutdown
            error = $message
            recoveredVersion = $recoveredVersion
            failedAt = [DateTimeOffset]::Now.ToString('o')
            logPath = $logPath
            callbackStatus = if ($callbackAttempted) { 'uncertain-no-resend' } else { 'not-attempted' }
        }
        Write-RefreshResult -Result $failureResult
        if (-not $callbackAttempted) {
            $callbackAttempted = $true
            $failureResult.callbackStatus = 'dispatching'
            Write-RefreshResult -Result $failureResult
            try {
                $delivery = Send-CompletionCallback -FailureMessage $message
                $failureResult.callbackStatus = 'accepted'
                $failureResult.callbackMode = $delivery.mode
                $failureResult.callbackTurnId = $delivery.turnId
            }
            catch { $failureResult.callbackStatus = 'uncertain-no-resend' }
            Write-RefreshResult -Result $failureResult
        }
        $controllerExitCode = 1
    }
}
finally {
    Exit-ExclusiveMutex -Mutex $controllerMutex
}

if ($controllerExitCode -ne 0) {
    exit $controllerExitCode
}
