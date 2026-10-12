[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-f-]{36}$')][string]$ThreadId,
    [ValidatePattern('^[0-9a-f-]{36}$')][string]$TurnId,
    [string]$SourceRollout,
    [string]$Since,
    [string]$ProjectRecoveryBackup,
    [switch]$SkipPackageUpdateWait,
    [switch]$GracefulOnly,
    [switch]$PreserveRunningBridge,
    [switch]$Controller,
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$launcherRoot = $PSScriptRoot
$repositoryRoot = Split-Path -Parent $launcherRoot
. (Join-Path $launcherRoot 'CodexNodeRuntime.ps1')
. (Join-Path $launcherRoot 'CodexDesktopPackage.ps1')
. (Join-Path $launcherRoot 'CodexRuntimeCache.ps1')
. (Join-Path $launcherRoot 'CodexDesktopStartup.ps1')
. (Join-Path $launcherRoot 'CodexDesktopShutdown.ps1')
$nodeExecutable = Initialize-CodexNodeRuntime -StateRoot (Join-Path $launcherRoot 'state')
$sessionsRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\sessions'
$inspectionScript = Join-Path $launcherRoot 'private-turn-state.mjs'
$projectRecoveryScript = Join-Path $launcherRoot 'restore-desktop-projects.mjs'
$statusScript = Join-Path $repositoryRoot 'discord-bridge\Get-DiscordBridgeStatus.ps1'
$runtimePath = Join-Path $launcherRoot 'state\current.json'
$powerShellExecutable = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-Receipt {
    $receipt.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $temporary = "$($request.receiptPath).$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $request.receiptPath -Force
}
function Write-BootstrapLog([string]$Message) {
    Add-Content -LiteralPath $request.logPath -Value "$([DateTimeOffset]::UtcNow.ToString('o')) $Message" -Encoding UTF8
}
function Get-PrivateSnapshot {
    $output = @(& $nodeExecutable $inspectionScript --sessions $sessionsRoot --source $request.sourceRollout --thread $request.threadId --turn $request.turnId --since $request.since 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Private lifecycle inspection failed. Desktop was preserved.' }
    ($output -join "`n") | ConvertFrom-Json
}
function Get-VerifiedNewRuntime {
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { return $null }
    $state = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.websocketUrl -ne 'ws://127.0.0.1:8798' -or $state.desktopConnectionVerified -ne $true) { return $null }
    $listener = @(Get-NetTCPConnection -LocalPort 8798 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -ne 1 -or $listener[0].LocalAddress -ne '127.0.0.1' -or [int]$listener[0].OwningProcess -ne [int]$state.serverProcessId) { return $null }
    $server = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverProcessId)"
    if ($null -eq $server -or $server.ExecutablePath -ne $state.serverExecutable -or (Get-CodexFileSha256 -Path $state.serverExecutable) -ne $state.serverSha256) { return $null }
    $desktopIds = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $state.desktopExecutable } | ForEach-Object { [int]$_.ProcessId })
    $connections = @(Get-NetTCPConnection -State Established -RemotePort 8798 -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -in @('127.0.0.1','::1','::ffff:127.0.0.1') -and $desktopIds -contains [int]$_.OwningProcess })
    if ($connections.Count -eq 0) { return $null }
    if ((Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8798/readyz' -TimeoutSec 2).StatusCode -ne 200) { return $null }
    return $state
}

if (-not $Controller) {
    if (-not $ThreadId -or -not $TurnId -or -not $SourceRollout -or -not $Since) { throw 'An exact source thread, turn, rollout and timestamp are required.' }
    $package = Get-CodexDesktopPackageInfo -RequireBundledRuntime
    $roots = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $package.DesktopExecutable -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
    if ($roots.Count -ne 1) { throw 'Exactly one verified private Desktop root is required.' }
    if (@(Get-NetTCPConnection -LocalPort 8798 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Port 8798 is already owned. Use the existing shared refresh controller.' }
    if ($ProjectRecoveryBackup) {
        $ProjectRecoveryBackup = [IO.Path]::GetFullPath($ProjectRecoveryBackup)
        $validation = @(& $nodeExecutable $projectRecoveryScript --validate-backup --backup $ProjectRecoveryBackup 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'The selected project recovery backup is not valid. Desktop was preserved.' }
    }
    $requestId = [Guid]::NewGuid().ToString()
    $taskName = 'Codex Shared Bootstrap ' + $requestId.Substring(0,8)
    $RequestPath = Join-Path $launcherRoot "state\bootstrap-$requestId-request.json"
    $privateServers = @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object { [int]$_.ParentProcessId -eq [int]$roots[0].ProcessId -and $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and $_.CommandLine -notmatch '--listen\s+ws://' } | Select-Object ProcessId,ExecutablePath,CreationDate)
    $request = [ordered]@{
        schemaVersion = 1; requestId = $requestId; threadId = $ThreadId; turnId = $TurnId
        sourceRollout = [IO.Path]::GetFullPath($SourceRollout); since = $Since
        taskName = $taskName; fromVersion = $package.Version
        oldDesktopExecutable = $package.DesktopExecutable
        oldRootProcessId = [int]$roots[0].ProcessId; oldRootCreationDate = $roots[0].CreationDate.ToString('o')
        oldRootStartTimeUtc = (Get-Process -Id $roots[0].ProcessId).StartTime.ToUniversalTime().ToString('o')
        oldPrivateServers = $privateServers
        controllerScript = $PSCommandPath; controllerSha256 = (Get-FileHash -LiteralPath $PSCommandPath).Hash
        inspectionSha256 = (Get-FileHash -LiteralPath $inspectionScript).Hash
        dependencyHashes = @{
            'CodexDesktopStartup.ps1' = (Get-FileHash -LiteralPath (Join-Path $launcherRoot 'CodexDesktopStartup.ps1')).Hash
            'CodexDesktopShutdown.ps1' = (Get-FileHash -LiteralPath (Join-Path $launcherRoot 'CodexDesktopShutdown.ps1')).Hash
            'CodexDesktopShutdown.cs' = (Get-FileHash -LiteralPath (Join-Path $launcherRoot 'CodexDesktopShutdown.cs')).Hash
            'Start-CodexShared.ps1' = (Get-FileHash -LiteralPath (Join-Path $launcherRoot 'Start-CodexShared.ps1')).Hash
        }
        projectRecoveryBackup = $ProjectRecoveryBackup
        projectRecoveryBackupSha256 = if ($ProjectRecoveryBackup) { (Get-FileHash -LiteralPath $ProjectRecoveryBackup).Hash } else { $null }
        projectRecoveryScriptSha256 = (Get-FileHash -LiteralPath $projectRecoveryScript).Hash
        skipPackageUpdateWait = [bool]$SkipPackageUpdateWait
        gracefulOnly = [bool]$GracefulOnly
        preserveRunningBridge = [bool]$PreserveRunningBridge
        receiptPath = (Join-Path $launcherRoot "state\bootstrap-$requestId-result.json")
        logPath = (Join-Path $launcherRoot "logs\bootstrap-$requestId.log")
    }
    $snapshot = Get-PrivateSnapshot
    if ($snapshot.sourceStatus -ne 'task_started') { throw 'A non-active source turn was found; no task was armed.' }
    if ($null -eq (Get-ScheduledTask -TaskName 'Codex Discord Remote' -ErrorAction SilentlyContinue)) { throw 'Install the Bridge logon task first.' }
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'The proposed one-shot task already exists. No task was replaced.' }
    [IO.File]::WriteAllText($RequestPath, ($request | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $action = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$PSCommandPath`" -Controller -RequestPath `"$RequestPath`"" -WorkingDirectory $repositoryRoot
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'One-shot authorized private-to-shared Codex Desktop update and Bridge activation.' | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $request.receiptPath) {
            $armed = Get-Content -LiteralPath $request.receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($armed.requestId -eq $requestId -and $armed.phase -eq 'waiting-for-source-turn' -and $armed.controllerProcessId -ne $PID) {
                [pscustomobject]@{Armed=$true;TaskName=$taskName;ControllerPid=$armed.controllerProcessId;RequestPath=$RequestPath;ReceiptPath=$request.receiptPath;LogPath=$request.logPath}
                return
            }
            if ($armed.phase -eq 'failed') { throw 'The controller failed during admission. Inspect the receipt.' }
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Scheduled launch was not confirmed. Do not duplicate it; inspect its receipt first.'
}

$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($request.schemaVersion -ne 1 -or $request.controllerScript -ne $PSCommandPath -or $request.controllerSha256 -ne (Get-FileHash -LiteralPath $PSCommandPath).Hash -or $request.inspectionSha256 -ne (Get-FileHash -LiteralPath $inspectionScript).Hash) { throw 'The admitted controller or lifecycle inspector changed. No Desktop process was touched.' }
if ($request.PSObject.Properties.Name -contains 'dependencyHashes') {
    foreach ($dependency in $request.dependencyHashes.PSObject.Properties) {
        if ($dependency.Value -ne (Get-FileHash -LiteralPath (Join-Path $launcherRoot $dependency.Name)).Hash) { throw 'An admitted startup/shutdown dependency changed. Desktop was preserved.' }
    }
}
if ($request.PSObject.Properties.Name -contains 'projectRecoveryBackup' -and $request.projectRecoveryBackup) {
    if ($request.projectRecoveryBackupSha256 -ne (Get-FileHash -LiteralPath $request.projectRecoveryBackup).Hash -or $request.projectRecoveryScriptSha256 -ne (Get-FileHash -LiteralPath $projectRecoveryScript).Hash) { throw 'The admitted project recovery source or script changed. Desktop was preserved.' }
}
if (Test-Path -LiteralPath $request.receiptPath) { throw 'This request was already started. Its receipt was preserved.' }
$controllerMutex = [Threading.Mutex]::new($false, 'Local\CodexSharedDesktopBootstrap')
try { $controllerOwned = $controllerMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $controllerOwned = $true }
if (-not $controllerOwned) { $controllerMutex.Dispose(); throw 'Another local Desktop bootstrap is running. No process was touched.' }
$receipt = [ordered]@{schemaVersion=1;requestId=$request.requestId;phase='waiting-for-source-turn';ok=$null;controllerProcessId=$PID;threadId=$request.threadId;turnId=$request.turnId;fromVersion=$request.fromVersion;taskName=$request.taskName;logPath=$request.logPath;updatedAt=$null}
$newState = $null
$callbackAttempted = $false
$desktopClosed = $false
try {
    Write-Receipt
    Write-BootstrapLog 'Controller is independent of Desktop. Waiting for the exact source turn and newly-started work.'
    $idleChecks = 0
    while ($true) {
        if (Test-Path -LiteralPath "$RequestPath.cancel") { throw [OperationCanceledException]::new('Bootstrap cancelled before Desktop shutdown.') }
        $snapshot = Get-PrivateSnapshot
        # Turn IDs diagnose the originating request; newer input does not revoke
        # the requested restart. Newly active work must still drain before close.
        if ($snapshot.sourceStatus -in @('task_complete','turn_aborted') -and @($snapshot.activeThreadIds).Count -eq 0) { $idleChecks += 1 } else { $idleChecks = 0 }
        if ($idleChecks -ge 5) { break }
        Start-Sleep -Seconds 2
    }
    $receipt.phase = 'closing-private-desktop'; Write-Receipt
    $liveRoot = Get-CimInstance Win32_Process -Filter "ProcessId=$($request.oldRootProcessId)"
    if ($null -eq $liveRoot -or $liveRoot.ExecutablePath -ne $request.oldDesktopExecutable -or $liveRoot.CreationDate.ToString('o') -ne $request.oldRootCreationDate -or $liveRoot.CommandLine -match '(?:^|\s)--type=') { throw 'The admitted Desktop root changed. No process was stopped.' }
    $status = & $statusScript -Json | ConvertFrom-Json
    if ($status.ProcessAlive -and -not ($request.PSObject.Properties.Name -contains 'preserveRunningBridge' -and $request.preserveRunningBridge)) { & (Join-Path $repositoryRoot 'discord-bridge\Stop-DiscordBridge.ps1') -TimeoutSeconds 30 | Out-Null }
    $rootProcess = Get-Process -Id $request.oldRootProcessId
    if ($request.PSObject.Properties.Name -contains 'gracefulOnly' -and $request.gracefulOnly) {
        $receipt.shutdownPhase = 'dispatching-normal-request'; Write-Receipt
        $shutdown = Invoke-CodexDesktopNormalShutdown -ProcessId $request.oldRootProcessId -ExpectedExecutable $request.oldDesktopExecutable -ExpectedStartTimeUtc $request.oldRootStartTimeUtc -Execute
        $receipt.shutdownReturnCode = $shutdown.ReturnCode; Write-Receipt
        if ($shutdown.ReturnCode -ne 0) { throw "Desktop rejected the non-forced application-only shutdown: $($shutdown.ReturnCode). No shutdown retry or forced termination was attempted." }
    } elseif (-not $rootProcess.CloseMainWindow()) { throw 'Desktop did not accept the normal close request.' }
    Write-BootstrapLog 'Non-forced Desktop shutdown requested after five idle checks; no goals were paused.'
    $closeDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    while ([DateTimeOffset]::UtcNow -lt $closeDeadline -and (Get-Process -Id $request.oldRootProcessId -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }
    $liveRoot = Get-CimInstance Win32_Process -Filter "ProcessId=$($request.oldRootProcessId)"
    if ($null -ne $liveRoot) {
        if ($liveRoot.ExecutablePath -ne $request.oldDesktopExecutable -or $liveRoot.CreationDate.ToString('o') -ne $request.oldRootCreationDate) { throw 'Desktop PID ownership changed.' }
        $snapshot = Get-PrivateSnapshot
        if (@($snapshot.activeThreadIds).Count -gt 0) { throw 'New work appeared. Forced close was cancelled.' }
        if ($request.PSObject.Properties.Name -contains 'gracefulOnly' -and $request.gracefulOnly) { throw 'Desktop remains open after its normal close request. No forced closure is authorized; Desktop was preserved.' }
        Write-BootstrapLog 'Desktop remained in the tray; stopping only the admitted, idle root.'
        Stop-Process -Id $request.oldRootProcessId -Force
    }
    $desktopClosed = $true
    foreach ($privateServer in $request.oldPrivateServers) {
        $liveServer = Get-CimInstance Win32_Process -Filter "ProcessId=$($privateServer.ProcessId)"
        if ($null -ne $liveServer -and $liveServer.ExecutablePath -eq $privateServer.ExecutablePath -and $liveServer.CreationDate -eq [datetime]$privateServer.CreationDate -and [int]$liveServer.ParentProcessId -eq [int]$request.oldRootProcessId) {
            if ($request.PSObject.Properties.Name -contains 'gracefulOnly' -and $request.gracefulOnly) { throw 'A private AppServer remains after normal Desktop shutdown. It was not force-stopped.' }
            Write-BootstrapLog "Stopping orphaned private stdio server pid=$($privateServer.ProcessId)."
            Stop-Process -Id $privateServer.ProcessId -Force
        }
    }
    if ($request.PSObject.Properties.Name -contains 'projectRecoveryBackup' -and $request.projectRecoveryBackup) {
        $receipt.phase = 'restoring-desktop-project-metadata'; Write-Receipt
        # The Desktop writer is now stopped; preserve its latest non-project state.
        $stateHome = if ($env:CODEX_HOME) { [IO.Path]::GetFullPath($env:CODEX_HOME) } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
        $restoration = @(& $nodeExecutable $projectRecoveryScript --global-state (Join-Path $stateHome '.codex-global-state.json') --backup $request.projectRecoveryBackup --backup-directory (Join-Path $launcherRoot 'state\project-sync-backups') 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Project restoration failed. Inspect the preserved source and state backups.' }
        $receipt.projectRecovery = ($restoration -join "`n") | ConvertFrom-Json
        Write-BootstrapLog "Project metadata restored: projects=$($receipt.projectRecovery.projects) assignments=$($receipt.projectRecovery.assignments)."
        Write-Receipt
    }
    $receipt.phase = 'activating-pending-store-update'; Write-Receipt
    $skipUpdateWait = $request.PSObject.Properties.Name -contains 'skipPackageUpdateWait' -and $request.skipPackageUpdateWait
    $updateDeadline = [DateTimeOffset]::UtcNow.AddSeconds($(if ($skipUpdateWait) { 0 } else { 90 }))
    do {
        $package = Get-CodexDesktopPackageInfo -RequireBundledRuntime
        if ([version]$package.Version -gt [version]$request.fromVersion) { break }
        if ($skipUpdateWait) { break }
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $updateDeadline)
    $receipt.toVersion = $package.Version
    $receipt.packageUpdateApplied = [version]$package.Version -gt [version]$request.fromVersion
    Write-BootstrapLog "Latest registered package=$($package.Version), package update applied=$($receipt.packageUpdateApplied)."
    $receipt.phase = 'starting-shared-desktop'; Write-Receipt
    $progressPath = Join-Path $launcherRoot "state\bootstrap-$($request.requestId)-startup.json"
    $supervisor = Start-Process -FilePath $powerShellExecutable -ArgumentList "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$(Join-Path $launcherRoot 'Start-CodexShared.ps1')`" -NoDialogs -RuntimeSupervisor -ProgressPath `"$progressPath`"" -WindowStyle Hidden -PassThru
    $receipt.supervisorProcessId = $supervisor.Id; $receipt.supervisorStartTimeUtc = $supervisor.StartTime.ToUniversalTime().ToString('o'); $receipt.progressPath = $progressPath; Write-Receipt
    $startupWatch = [Diagnostics.Stopwatch]::StartNew()
    $lastProgressSeconds = 0.0; $lastStage = 0; $progressOffsets = @{}
    $phaseRanks = @{preparing=1; 'server-ready'=2; 'syncing-projects'=3; 'desktop-starting'=4; 'desktop-connecting'=5; ready=6; 'bridge-ready'=7}
    while ($true) {
        try { $newState = Get-VerifiedNewRuntime } catch { $newState = $null }
        if ($null -ne $newState) { break }
        if (Test-Path -LiteralPath "$RequestPath.cancel") { throw [OperationCanceledException]::new('Bootstrap verification cancelled; no running application was stopped.') }
        $supervisor.Refresh()
        if ($supervisor.HasExited) { throw 'The admitted shared supervisor exited; inspect its startup receipt before any retry.' }
        $stage = 0
        if (Test-Path -LiteralPath $progressPath) {
            $progress = Get-Content -LiteralPath $progressPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([int]$progress.supervisorProcessId -ne $supervisor.Id) { throw 'Startup progress belongs to a different process.' }
            if ($progress.phase -in @('failed','cancelled','skipped')) { throw "The shared supervisor stopped startup: $($progress.phase). Inspect its progress receipt." }
            if ($phaseRanks.ContainsKey($progress.phase)) { $stage = 100 * $phaseRanks[$progress.phase] }
        }
        $roots = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $package.DesktopExecutable -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
        if ($roots.Count -gt 0) { $stage += Read-CodexDesktopStartupProgress -DesktopRoots $roots -Offsets $progressOffsets -PackageInfo $package }
        if ($stage -gt $lastStage) {
            $lastStage = $stage; $lastProgressSeconds = $startupWatch.Elapsed.TotalSeconds
            Write-BootstrapLog "Verified forward startup stage=$lastStage; no total runtime limit."
        }
        if ($startupWatch.Elapsed.TotalSeconds - $lastProgressSeconds -ge 180) { throw 'Shared startup made no verified forward progress for three minutes. Its live processes were not force-stopped.' }
        Start-Sleep -Seconds 1
    }
    $probe = @(& $nodeExecutable (Join-Path $launcherRoot 'verify-shared-connection.mjs') 'ws://127.0.0.1:8798' 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Shared AppServer protocol/membership verification failed.' }
    $receipt.desktopConnectionVerified = $true
    $receipt.serverProcessId = [int]$newState.serverProcessId
    $receipt.sharedProtocolVerified = $true
    $receipt.phase = 'starting-discord-bridge'; Write-Receipt
    Start-ScheduledTask -TaskName 'Codex Discord Remote'
    $bridgeDeadline = [DateTimeOffset]::UtcNow.AddMinutes(3)
    do {
        $status = & $statusScript -Json | ConvertFrom-Json
        if ($status.ProcessAlive -and $status.DiscordReady -and $status.CodexConnected -and $status.AppServerReady) { break }
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $bridgeDeadline)
    if (-not ($status.ProcessAlive -and $status.DiscordReady -and $status.CodexConnected -and $status.AppServerReady)) { throw 'The Bridge did not become Discord-ready and shared-AppServer-connected.' }
    $receipt.bridgeConnected = $true
    $receipt.bridgeProcessId = $status.Pid
    $receipt.ok = $true
    $receipt.phase = 'verification-completed'
    Write-BootstrapLog 'Shared Desktop and Discord Bridge were verified live.'
} catch {
    $receipt.ok = $false; $receipt.phase = if ($_.Exception -is [OperationCanceledException]) { 'cancelled' } else { 'failed' }; $receipt.error = $_.Exception.Message
    Write-BootstrapLog $receipt.error
    if ($desktopClosed -and $null -eq $newState) {
        # Restore a visible Desktop if shared launch failed. Never kill a new root to retry blindly.
        $package = Get-CodexDesktopPackageInfo
        $roots = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $package.DesktopExecutable -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
        if ($roots.Count -eq 0) {
            Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList "shell:AppsFolder\$($package.ApplicationUserModelId)" -WindowStyle Hidden | Out-Null
            Write-BootstrapLog 'Normal Desktop reactivation requested after failed shared startup.'
        }
    }
}
Write-Receipt
if ($null -ne $newState) {
    try {
        $callbackAttempted = $true
        $receipt.callbackAttempted = $true; $receipt.callbackPhase = 'dispatching'; Write-Receipt
        # Re-read the verified canonical endpoint at delivery time. The control
        # utility resumes the same thread and reads its latest active turn.
        $deliveryState = Get-VerifiedNewRuntime
        if ($null -eq $deliveryState) { throw 'The verified canonical runtime is no longer available; no callback was sent.' }
        $message = "Windows Scheduler bootstrap has finished. Request id: $($request.requestId). Receipt: $($request.receiptPath). Log: $($request.logPath). Read the receipt first. Continue the latest user request: recover failed shared AppServer startup and restore missing local projects/sidebar after the Desktop update. Verify the live shared AppServer, Desktop, DiscordBridge and restored project assignments. Do not rerun this bootstrap solely because of this callback. If startup or Bridge failed, diagnose and complete recovery. Preserve this task's workspace, permissions, model and existing Git changes. No user action is required."
        $output = @(& $nodeExecutable (Join-Path $repositoryRoot 'control\codex-control.mjs') deliver $request.threadId --url $deliveryState.websocketUrl --message $message --compact 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Callback delivery was uncertain; it was not automatically retried.' }
        $delivery = ($output -join "`n") | ConvertFrom-Json
        if ($delivery.accepted -ne $true -or $delivery.threadId -ne $request.threadId) { throw 'Callback acceptance was not confirmed.' }
        $receipt.callbackTurnId = $delivery.turnId; $receipt.callbackMode = $delivery.mode; $receipt.callbackAccepted = $true
        $receipt.callbackPhase = 'delivered'
        if ($receipt.ok) { $receipt.phase = 'completed' }
        Write-BootstrapLog "Continuation accepted: turn=$($delivery.turnId)."
    } catch { $receipt.callbackAccepted = $false; $receipt.callbackError = $_.Exception.Message; Write-BootstrapLog $receipt.callbackError }
    Write-Receipt
}
$controllerMutex.ReleaseMutex()
$controllerMutex.Dispose()
if (-not $receipt.ok) { exit 1 }
