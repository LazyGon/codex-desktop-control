[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8798,

    [switch]$SelfTest,

    [switch]$NoSound,

    [switch]$NoDialogs,

    [string]$ProgressPath,

    [switch]$InteractiveWorker,

    [switch]$RuntimeSupervisor,

    [int]$ProgressOwnerProcessId = 0,

    [ValidateSet('All', 'Shared', 'Desktop', 'Bridge')]
    [string]$RetryStep = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
    # Also publish failures before dependency loading and runtime initialization.
    if (-not [string]::IsNullOrWhiteSpace($ProgressPath)) {
        $failure = [ordered]@{
            schemaVersion = 1
            launcherProcessId = if ($ProgressOwnerProcessId -gt 0) { $ProgressOwnerProcessId } else { $PID }
            supervisorProcessId = $PID
            phase = 'failed'
            step = 'Shared'
            summary = '起動準備に失敗しました。'
            detail = $_.Exception.Message
            serverStatus = '失敗'
            desktopStatus = '未実行'
            logPath = ''
            updatedAt = [DateTimeOffset]::Now.ToString('o')
        }
        try {
            $temporaryFailure = "$ProgressPath.$PID.tmp"
            [IO.File]::WriteAllText($temporaryFailure, ($failure | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporaryFailure -Destination $ProgressPath -Force
        }
        catch { }
    }
    exit 1
}

$launcherRoot = Split-Path -Parent $PSCommandPath
$logRoot = Join-Path $launcherRoot 'logs'
$stateRoot = Join-Path $launcherRoot 'state'
$cacheRoot = Join-Path $launcherRoot 'cache'
$runtimeCacheScript = Join-Path $launcherRoot 'CodexRuntimeCache.ps1'
$desktopPackageScript = Join-Path $launcherRoot 'CodexDesktopPackage.ps1'
$processEnvironmentScript = Join-Path $launcherRoot 'CodexProcessEnvironment.ps1'
$codexAppToolsConfigScript = Join-Path $launcherRoot 'CodexAppToolsSharedConfig.ps1'
$codexAppToolsBridgeScript = Join-Path $launcherRoot 'codex-app-tools-bridge.mjs'
$runtimeUpdateDrainScript = Join-Path $launcherRoot 'runtime-update-drain.mjs'
$runtimeUpdateStatePath = Join-Path $stateRoot 'package-update-drain.json'
$launcherExecutable = Join-Path $launcherRoot 'CodexSharedLauncher.exe'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $runtimeCacheScript -PathType Leaf)) {
    throw "Codex runtime cache helper was not found: $runtimeCacheScript"
}
if (-not (Test-Path -LiteralPath $desktopPackageScript -PathType Leaf)) {
    throw "Codex Desktop package helper was not found: $desktopPackageScript"
}
if (-not (Test-Path -LiteralPath $processEnvironmentScript -PathType Leaf)) {
    throw "Codex process environment helper was not found: $processEnvironmentScript"
}
if (-not (Test-Path -LiteralPath $codexAppToolsConfigScript -PathType Leaf)) {
    throw "Shared codex-app-tools config helper was not found: $codexAppToolsConfigScript"
}
if (-not (Test-Path -LiteralPath $codexAppToolsBridgeScript -PathType Leaf)) {
    throw "Shared codex-app-tools bridge was not found: $codexAppToolsBridgeScript"
}
if (-not (Test-Path -LiteralPath $runtimeUpdateDrainScript -PathType Leaf)) {
    throw "Runtime update drain helper was not found: $runtimeUpdateDrainScript"
}
. $runtimeCacheScript
. $desktopPackageScript
. $processEnvironmentScript
. $codexAppToolsConfigScript
. (Join-Path $launcherRoot 'CodexNodeRuntime.ps1')
$null = Initialize-CodexNodeRuntime -StateRoot $stateRoot

$cliRedirectEnabledForChildProcesses = Enable-CodexCliRedirectForChildProcesses

$runStamp = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID
$modeName = if ($SelfTest) { 'selftest' } else { 'desktop' }
$logPath = Join-Path $logRoot "$runStamp-$modeName.log"
$serverStdoutPath = Join-Path $logRoot "$runStamp-app-server.stdout.log"
$serverStderrPath = Join-Path $logRoot "$runStamp-app-server.stderr.log"
$stateFileName = if ($SelfTest) { "selftest-$Port-current.json" } else { 'current.json' }
$statePath = Join-Path $stateRoot $stateFileName
$projectSyncResultPath = Join-Path $stateRoot 'project-sync-last.json'
$projectSyncBackupRoot = Join-Path $stateRoot 'project-sync-backups'

function Write-LauncherLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffK'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Write-LauncherProgress {
    param(
        [Parameter(Mandatory)][string]$Phase,
        [Parameter(Mandatory)][string]$Summary,
        [string]$Detail = '',
        [string]$ServerStatus = '確認中…',
        [string]$DesktopStatus = '起動待ち…'
    )

    if ([string]::IsNullOrWhiteSpace($ProgressPath)) { return }
    if ($Phase -match '^desktop-|^syncing-') { $script:startupStep = 'Desktop' }
    elseif ($Phase -match '^bridge-') { $script:startupStep = 'Bridge' }
    elseif ($Phase -in @('preparing', 'waiting-for-owner', 'server-ready')) { $script:startupStep = 'Shared' }
    if (-not (Get-Variable -Name startupStep -Scope Script -ErrorAction SilentlyContinue)) { $script:startupStep = 'Shared' }
    $progress = [ordered]@{
        schemaVersion = 1
        launcherProcessId = if ($ProgressOwnerProcessId -gt 0) { $ProgressOwnerProcessId } else { $PID }
        supervisorProcessId = $PID
        phase = $Phase
        step = $script:startupStep
        summary = $Summary
        detail = $Detail
        serverStatus = $ServerStatus
        desktopStatus = $DesktopStatus
        logPath = $logPath
        updatedAt = [DateTimeOffset]::Now.ToString('o')
    }
    $temporary = "$ProgressPath.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($progress | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $ProgressPath -Force
}

function Assert-LauncherNotCancelled {
    if ($ProgressPath -and (Test-Path -LiteralPath "$ProgressPath.cancel" -PathType Leaf)) {
        throw [OperationCanceledException]::new('起動操作を中止しました。')
    }
}

function Invoke-RuntimeUpdateDrain {
    param(
        [Parameter(Mandatory)][ValidateSet('pause-active', 'active', 'resume-paused')][string]$Command,
        [Parameter(Mandatory)][string]$WebSocketUrl,
        [AllowNull()][string]$FromVersion,
        [AllowNull()][string]$ToVersion
    )

    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $arguments = @($runtimeUpdateDrainScript, $Command, '--endpoint', $WebSocketUrl)
    if ($Command -in @('pause-active', 'resume-paused')) {
        $arguments += @('--state', $runtimeUpdateStatePath)
    }
    if ($Command -eq 'pause-active') {
        $arguments += @('--from-version', $FromVersion, '--to-version', $ToVersion)
    }

    $output = @(& $nodeExecutable @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Runtime update drain command failed ($Command): $($output -join [Environment]::NewLine)"
    }
    if ($output.Count -eq 0) {
        throw "Runtime update drain command returned no result: $Command"
    }
    $output[-1] | ConvertFrom-Json
}

function Wait-RuntimeUpdateQuiescence {
    param(
        [Parameter(Mandatory)][string]$WebSocketUrl,
        [Parameter(Mandatory)][string]$FromVersion,
        [Parameter(Mandatory)][string]$ToVersion
    )

    $consecutiveIdleChecks = 0
    $lastActiveSet = $null
    while ($consecutiveIdleChecks -lt 5) {
        try {
            $drain = Invoke-RuntimeUpdateDrain `
                -Command 'pause-active' `
                -WebSocketUrl $WebSocketUrl `
                -FromVersion $FromVersion `
                -ToVersion $ToVersion
            $activeThreadIds = @($drain.activeThreadIds)
            $activeSet = $activeThreadIds -join ','
            if ($activeSet -ne $lastActiveSet) {
                Write-LauncherLog (
                    "Runtime update drain observed active threads. count=$($activeThreadIds.Count) " +
                    "ids=$activeSet"
                )
                $lastActiveSet = $activeSet
            }
            if ($activeThreadIds.Count -eq 0) {
                $consecutiveIdleChecks += 1
            }
            else {
                $consecutiveIdleChecks = 0
            }
        }
        catch {
            $consecutiveIdleChecks = 0
            Write-LauncherLog "Runtime update drain inspection failed; preserving the current server: $($_.Exception.Message)"
        }
        if ($consecutiveIdleChecks -lt 5) {
            Start-Sleep -Seconds 1
        }
    }
    Write-LauncherLog 'Runtime update drain reached five consecutive idle checks.'
}

function Restore-RuntimeUpdateGoals {
    param(
        [Parameter(Mandatory)][string]$WebSocketUrl,
        [Parameter(Mandatory)][string]$PackageVersion
    )

    if (-not (Test-Path -LiteralPath $runtimeUpdateStatePath -PathType Leaf)) {
        return
    }
    try {
        $state = Get-Content -LiteralPath $runtimeUpdateStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($state.phase -eq 'completed' -or $state.toVersion -ne $PackageVersion) {
            return
        }
    }
    catch {
        Write-LauncherLog "Unable to inspect paused-goal update state: $($_.Exception.Message)"
        return
    }

    for ($attempt = 1; $attempt -le 5; $attempt += 1) {
        try {
            $restored = Invoke-RuntimeUpdateDrain `
                -Command 'resume-paused' `
                -WebSocketUrl $WebSocketUrl `
                -FromVersion $null `
                -ToVersion $null
            Write-LauncherLog (
                "Runtime update goals restored. resumed=$(@($restored.resumedThreadIds).Count) " +
                "unchanged=$(@($restored.unchangedThreadIds).Count)"
            )
            return
        }
        catch {
            Write-LauncherLog "Runtime update goal restore attempt $attempt failed: $($_.Exception.Message)"
            if ($attempt -lt 5) {
                Start-Sleep -Seconds 1
            }
        }
    }
    Write-LauncherLog 'Paused goals remain paused because all automatic restore attempts failed.'
}

Write-LauncherLog "CLI redirect enabled for child processes: $cliRedirectEnabledForChildProcesses"

function Show-LauncherMessage {
    param(
        [Parameter(Mandatory)][string]$Message,
        [int]$Icon = 48,
        [int]$TimeoutSeconds = 30
    )

    if ($NoDialogs) {
        return
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message, $TimeoutSeconds, 'Codex Shared Server', $Icon)
    }
    catch {
        Write-LauncherLog "Unable to show message dialog: $($_.Exception.Message)"
    }
}

function Invoke-LauncherSignal {
    param([ValidateSet('Ready', 'Stopped', 'Error')][string]$Kind)

    if ($NoSound) {
        return
    }

    try {
        switch ($Kind) {
            'Ready' {
                [Console]::Beep(880, 140)
                Start-Sleep -Milliseconds 90
                [Console]::Beep(1175, 180)
            }
            'Stopped' {
                [Console]::Beep(740, 130)
                Start-Sleep -Milliseconds 80
                [Console]::Beep(523, 180)
            }
            'Error' {
                [Console]::Beep(330, 250)
            }
        }
    }
    catch {
        [System.Media.SystemSounds]::Exclamation.Play()
    }
}

function Get-CodexPackageInfo {
    $package = Get-CodexDesktopPackageInfo -RequireBundledRuntime

    $runtimeCache = Initialize-CodexRuntimeCache `
        -BundledServerExecutable $package.BundledServerExecutable `
        -BundledCodeModeHostExecutable $package.BundledCodeModeHostExecutable `
        -CacheRoot $cacheRoot `
        -PackageVersion $package.Version

    [pscustomobject]@{
        Version = $package.Version
        PackageFamilyName = $package.PackageFamilyName
        ApplicationUserModelId = $package.ApplicationUserModelId
        InstallLocation = $package.InstallLocation
        DesktopExecutable = $package.DesktopExecutable
        BundledServerExecutable = $package.BundledServerExecutable
        BundledCodeModeHostExecutable = $package.BundledCodeModeHostExecutable
        ServerExecutable = $runtimeCache.ServerExecutable
        ServerSha256 = $runtimeCache.ServerSha256
        CodeModeHostExecutable = $runtimeCache.CodeModeHostExecutable
        CodeModeHostSha256 = $runtimeCache.CodeModeHostSha256
    }
}

function Set-UserWebSocketEnvironment {
    param([Parameter(Mandatory)][string]$WebSocketUrl)

    $currentValue = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
    if ($currentValue -ne $WebSocketUrl) {
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $WebSocketUrl, 'User')
    }
    $env:CODEX_APP_SERVER_WS_URL = $WebSocketUrl

    if (-not ('CodexSharedLauncher.EnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexSharedLauncher
{
    public static class EnvironmentBroadcast
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr window, uint message, IntPtr wParam, string lParam,
            uint flags, uint timeout, out IntPtr result);

        public static void Notify()
        {
            IntPtr result;
            SendMessageTimeout(new IntPtr(0xffff), 0x001A, IntPtr.Zero,
                "Environment", 0x0002, 5000, out result);
        }
    }
}
'@
    }
    [CodexSharedLauncher.EnvironmentBroadcast]::Notify()
}

function Clear-UserWebSocketEnvironment {
    param([Parameter(Mandatory)][string]$ExpectedWebSocketUrl)

    $currentValue = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
    if ($currentValue -eq $ExpectedWebSocketUrl) {
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
        Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
        [CodexSharedLauncher.EnvironmentBroadcast]::Notify()
    }
}

function Get-CodexDesktopRootProcesses {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    $pattern = '^"?' + [regex]::Escape($DesktopExecutable) + '"?(?:\s|$)'
    @(
        Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -match $pattern -and
                $_.CommandLine -notmatch '(?:^|\s)--type='
            }
    )
}

function Get-CodexDesktopProcessIds {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    $pattern = '^"?' + [regex]::Escape($DesktopExecutable) + '"?(?:\s|$)'
    @(
        Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } |
            ForEach-Object { [int]$_.ProcessId }
    )
}

function Get-DesktopLocalAppServers {
    param([int[]]$DesktopRootProcessIds)

    if ($DesktopRootProcessIds.Count -eq 0) {
        return @()
    }

    @(
        Get-CimInstance Win32_Process -Filter "Name='codex.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $DesktopRootProcessIds -contains [int]$_.ParentProcessId -and
                $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and
                $_.CommandLine -notmatch '--listen\s+ws://'
            }
    )
}

function Assert-PortAvailable {
    param([Parameter(Mandatory)][int]$PortNumber)

    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $PortNumber)
    $probe.Server.ExclusiveAddressUse = $true
    try {
        $probe.Start()
    }
    catch {
        throw "TCP port 127.0.0.1:$PortNumber is already in use. No process was stopped."
    }
    finally {
        $probe.Stop()
    }
}

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append([char]34)
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) {
            $backslashes += 1
            continue
        }
        if ($character -eq [char]34) {
            [void]$builder.Append([char]92, ($backslashes * 2) + 1)
            [void]$builder.Append([char]34)
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append([char]92, $backslashes)
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append([char]92, $backslashes * 2)
    }
    [void]$builder.Append([char]34)
    $builder.ToString()
}

function Wait-AppServerReady {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory)][int]$PortNumber,
        [int]$TimeoutSeconds = 30
    )

    $uri = "http://127.0.0.1:$PortNumber/readyz"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        Assert-LauncherNotCancelled
        if ($Process.HasExited) {
            $stderrTail = if (Test-Path -LiteralPath $serverStderrPath) {
                (Get-Content -LiteralPath $serverStderrPath -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
            }
            else {
                ''
            }
            throw "app-server exited before it became ready (exit $($Process.ExitCode)). $stderrTail"
        }

        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                return
            }
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    }

    throw "app-server did not become ready within $TimeoutSeconds seconds: $uri"
}

function Test-DesktopWebSocketConnection {
    param(
        [Parameter(Mandatory)][string]$DesktopExecutable,
        [Parameter(Mandatory)][int]$PortNumber
    )

    $desktopProcessIds = @(Get-CodexDesktopProcessIds -DesktopExecutable $DesktopExecutable)
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

function Write-RuntimeState {
    param([Parameter(Mandatory)][object]$State)

    $temporaryPath = "$statePath.tmp"
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Set-RuntimeStateValue {
    param(
        [Parameter(Mandatory)][object]$State,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][AllowNull()][AllowEmptyCollection()][object]$Value
    )

    if ($State -is [System.Collections.IDictionary]) {
        $State[$Name] = $Value
        return
    }
    if ($null -ne $State.PSObject.Properties[$Name]) {
        $State.$Name = $Value
        return
    }
    $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
}

function Invoke-DesktopProjectSync {
    param([Parameter(Mandatory)][string]$WebSocketUrl)

    $syncScript = Join-Path $launcherRoot 'sync-desktop-projects.mjs'
    $bridgeStatePath = Join-Path (Split-Path -Parent $launcherRoot) 'discord-bridge\data\state.json'
    $codexStateRoot = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
    }
    else {
        [IO.Path]::GetFullPath($env:CODEX_HOME)
    }
    $globalStatePath = Join-Path $codexStateRoot '.codex-global-state.json'
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source

    if (-not (Test-Path -LiteralPath $syncScript -PathType Leaf)) {
        throw "Desktop project sync script was not found: $syncScript"
    }
    if (-not (Test-Path -LiteralPath $bridgeStatePath -PathType Leaf)) {
        Write-LauncherLog "Desktop project sync skipped because Bridge state does not exist yet: $bridgeStatePath"
        return
    }
    if (-not (Test-Path -LiteralPath $globalStatePath -PathType Leaf)) {
        Write-LauncherLog "Desktop project sync skipped because Desktop state does not exist yet: $globalStatePath"
        return
    }

    $syncOutput = @(
        & $nodeExecutable $syncScript `
            --endpoint $WebSocketUrl `
            --global-state $globalStatePath `
            --bridge-state $bridgeStatePath `
            --result $projectSyncResultPath `
            --backup-directory $projectSyncBackupRoot 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop project sync failed: $($syncOutput -join [Environment]::NewLine)"
    }
    Write-LauncherLog "Desktop project sync completed. $($syncOutput -join ' ')"
}

function Get-ReusableRuntimeState {
    param(
        [Parameter(Mandatory)][object]$PackageInfo,
        [Parameter(Mandatory)][int]$PortNumber,
        [switch]$SuppressFailureLog
    )

    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return $null
    }

    try {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $expectedWebSocketUrl = "ws://127.0.0.1:$PortNumber"
        $expectedReadyUrl = "http://127.0.0.1:$PortNumber/readyz"
        if (
            [int]$state.port -ne $PortNumber -or
            $state.websocketUrl -ne $expectedWebSocketUrl -or
            $state.readyUrl -ne $expectedReadyUrl
        ) {
            throw 'The recorded endpoint does not match the requested loopback endpoint.'
        }
        if (
            $state.packageVersion -ne $PackageInfo.Version -or
            $state.desktopExecutable -ne $PackageInfo.DesktopExecutable -or
            $state.serverExecutable -ne $PackageInfo.ServerExecutable -or
            $state.codeModeHostExecutable -ne $PackageInfo.CodeModeHostExecutable -or
            $state.codeModeHostSha256 -ne $PackageInfo.CodeModeHostSha256
        ) {
            throw 'The recorded runtime does not match the installed Codex package and this launcher cache.'
        }
        if ($state.desktopConnectionVerified -ne $true) {
            throw 'The recorded shared runtime has not completed Desktop connection verification.'
        }

        $listener = @(
            Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction Stop |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' }
        )
        if ($listener.Count -ne 1 -or [int]$listener[0].OwningProcess -ne [int]$state.serverProcessId) {
            throw 'The loopback listener owner does not match launcher state.'
        }

        $server = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverProcessId)" -ErrorAction Stop
        if (
            $null -eq $server -or
            -not $server.ExecutablePath -or
            $server.ExecutablePath -ne $PackageInfo.ServerExecutable
        ) {
            throw 'The live app-server executable does not match this launcher cache.'
        }

        $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.supervisorProcessId)" -ErrorAction Stop
        if (
            $null -eq $supervisor -or
            -not $supervisor.CommandLine -or
            $supervisor.CommandLine -notmatch [regex]::Escape($PSCommandPath)
        ) {
            throw 'The recorded shared-launcher supervisor is not alive or is owned by another launcher.'
        }

        $readyResponse = Invoke-WebRequest -UseBasicParsing -Uri $expectedReadyUrl -TimeoutSec 2
        if ($readyResponse.StatusCode -ne 200) {
            throw "The app-server ready endpoint returned HTTP $($readyResponse.StatusCode)."
        }

        return $state
    }
    catch {
        if (-not $SuppressFailureLog) {
            Write-LauncherLog "Existing runtime is not reusable: $($_.Exception.Message)"
        }
        return $null
    }
}

function Wait-ReusableRuntimeState {
    param(
        [Parameter(Mandatory)][object]$PackageInfo,
        [Parameter(Mandatory)][int]$PortNumber,
        [int]$TimeoutSeconds = 120,
        [int]$PollMilliseconds = 500
    )

    if ($TimeoutSeconds -le 0) { throw 'The concurrent-launch wait timeout must be positive.' }
    if ($PollMilliseconds -le 0) { throw 'The concurrent-launch poll interval must be positive.' }

    $wait = [Diagnostics.Stopwatch]::StartNew()
    while ($wait.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        Assert-LauncherNotCancelled
        $state = Get-ReusableRuntimeState `
            -PackageInfo $PackageInfo `
            -PortNumber $PortNumber `
            -SuppressFailureLog
        if ($null -ne $state) {
            return $state
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
    return $null
}

function Wait-DesktopSharedConnection {
    param(
        [Parameter(Mandatory)][object]$PackageInfo,
        [Parameter(Mandatory)][int]$PortNumber,
        [int]$TimeoutSeconds = 30,
        [int]$PollMilliseconds = 500
    )

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $helperLogged = $false
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        Assert-LauncherNotCancelled
        if (Test-DesktopWebSocketConnection -DesktopExecutable $PackageInfo.DesktopExecutable -PortNumber $PortNumber) {
            return $true
        }
        if (-not $helperLogged) {
            $roots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $PackageInfo.DesktopExecutable)
            $rootIds = @($roots | ForEach-Object { [int]$_.ProcessId })
            $helpers = @(Get-DesktopLocalAppServers -DesktopRootProcessIds $rootIds)
            if ($helpers.Count -gt 0) {
                Write-LauncherLog "Desktop bootstrap stdio helper observed; continuing to wait for its shared WebSocket. pid=$($helpers.ProcessId -join ',')"
                $helperLogged = $true
            }
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
    return $false
}

function Start-DesktopOnRuntime {
    param(
        [Parameter(Mandatory)][object]$PackageInfo,
        [Parameter(Mandatory)][object]$RuntimeState,
        [Parameter(Mandatory)][int]$PortNumber
    )

    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopExecutable' -Value $PackageInfo.DesktopExecutable
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopProcessIds' -Value @()
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopConnectionVerified' -Value $false
    Write-RuntimeState -State $RuntimeState

    Write-LauncherProgress -Phase 'syncing-projects' -Summary '共有サーバーは起動済みです。Desktop のプロジェクトを確認しています。' -ServerStatus '起動済み'
    Invoke-DesktopProjectSync -WebSocketUrl $RuntimeState.websocketUrl
    Assert-LauncherNotCancelled
    Set-UserWebSocketEnvironment -WebSocketUrl $RuntimeState.websocketUrl
    Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_APP_SERVER_USE_LOCAL_DAEMON -ErrorAction SilentlyContinue

    Write-LauncherProgress -Phase 'desktop-starting' -Summary 'Desktop を起動しています。' -ServerStatus '起動済み' -DesktopStatus '起動中…'
    $appsFolderTarget = "shell:AppsFolder\$($PackageInfo.ApplicationUserModelId)"
    Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList $appsFolderTarget | Out-Null
    Write-LauncherLog "Desktop package activation requested. appId=$($PackageInfo.ApplicationUserModelId)"

    $desktopRoots = @()
    $launchWatch = [Diagnostics.Stopwatch]::StartNew()
    while ($launchWatch.Elapsed.TotalSeconds -lt 30) {
        Assert-LauncherNotCancelled
        $desktopRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $PackageInfo.DesktopExecutable)
        if ($desktopRoots.Count -gt 0) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if ($desktopRoots.Count -eq 0) {
        throw 'Codex Desktop did not start within 30 seconds.'
    }
    $script:launchedDesktopRoots = $desktopRoots

    Set-RuntimeStateValue `
        -State $RuntimeState `
        -Name 'desktopProcessIds' `
        -Value @($desktopRoots | ForEach-Object { [int]$_.ProcessId })
    Write-RuntimeState -State $RuntimeState
    Write-LauncherLog "Desktop root detected. pid=$($RuntimeState.desktopProcessIds -join ',')"

    Write-LauncherProgress -Phase 'desktop-connecting' -Summary 'Desktop の共有接続を確認しています。' -ServerStatus '起動済み' -DesktopStatus '共有接続待ち…'
    $connectionVerified = Wait-DesktopSharedConnection -PackageInfo $PackageInfo -PortNumber $PortNumber

    if (-not $connectionVerified) {
        Show-LauncherMessage -Message "Codex started, but the shared app-server connection could not be verified.`n`nCodex remains open. See:`n$logPath" -Icon 16
        throw 'Desktop が 30 秒以内に共有 App Server へ接続しませんでした。初期化用の補助サーバーは待機対象に含めています。Desktop の認証画面と共有接続のログを確認してください。'
    }

    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopConnectionVerified' -Value $true
    Set-RuntimeStateValue `
        -State $RuntimeState `
        -Name 'desktopProcessIds' `
        -Value @(Get-CodexDesktopProcessIds -DesktopExecutable $PackageInfo.DesktopExecutable)
    Write-RuntimeState -State $RuntimeState
    Write-LauncherLog 'Desktop WebSocket connection verified.'
    Write-LauncherProgress -Phase 'ready' -Summary 'Desktop は共有サーバーに接続済みです。Discord Bridge を確認しています。' -ServerStatus '起動済み' -DesktopStatus '共有接続済み'

    [pscustomobject]@{
        RuntimeState = $RuntimeState
        DesktopProcessIds = @($RuntimeState.desktopProcessIds)
    }
}

function Remove-RuntimeStateIfOwned {
    param([int]$ExpectedServerProcessId)

    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return
    }

    try {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$state.serverProcessId -eq $ExpectedServerProcessId) {
            Remove-Item -LiteralPath $statePath -Force
        }
    }
    catch {
        Write-LauncherLog "Unable to inspect or remove runtime state: $($_.Exception.Message)"
    }
}

if (-not ('CodexSharedLauncher.KillOnCloseJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CodexSharedLauncher
{
    public sealed class KillOnCloseJob : IDisposable
    {
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private IntPtr handle;

        public KillOnCloseJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error());

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                if (!SetInformationJobObject(handle, 9, pointer, (uint)length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            catch
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        public void AddProcess(Process process)
        {
            if (handle == IntPtr.Zero)
                throw new ObjectDisposedException("KillOnCloseJob");
            if (!AssignProcessToJobObject(handle, process.Handle))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
            GC.SuppressFinalize(this);
        }

        ~KillOnCloseJob()
        {
            Dispose();
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
'@
}

$mutex = $null
$ownsMutex = $false
$jobObject = $null
$serverProcess = $null
$serverProcessId = 0
$exitCode = 1
$packageInfo = $null
$registeredWebSocketUrl = $null
$startupHandled = $false
$restartAfterCleanup = $false
$replacementPackageVersion = $null
$codexAppToolsDefinition = $null
$codexAppToolsConfigPath = $null
$launchedDesktopRoots = @()

function Invoke-InteractiveLauncherWorker {
    if (-not $ProgressPath) { throw 'An interactive worker requires its exact progress path.' }
    Write-LauncherProgress -Phase 'preparing' -Summary '起動項目を確認しています。'
    $shellName = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    $ownerInfo = [Diagnostics.ProcessStartInfo]::new()
    $ownerInfo.FileName = Join-Path $PSHOME $shellName
    $ownerInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File ' +
        (ConvertTo-WindowsCommandLineArgument -Value $PSCommandPath) +
        ' -NoDialogs -RuntimeSupervisor -ProgressPath ' + (ConvertTo-WindowsCommandLineArgument -Value $ProgressPath) +
        ' -ProgressOwnerProcessId ' + $PID + ' -RetryStep ' + $RetryStep + ' -Port ' + $Port
    $ownerInfo.WorkingDirectory = $launcherRoot
    $ownerInfo.UseShellExecute = $false
    $ownerInfo.CreateNoWindow = $true
    $ownerInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $owner = [Diagnostics.Process]::Start($ownerInfo)
    if ($null -eq $owner) { throw 'The shared runtime supervisor could not start.' }
    try {
        while (-not $owner.HasExited) {
            if (Test-Path -LiteralPath $ProgressPath -PathType Leaf) {
                try {
                    $result = Get-Content -LiteralPath $ProgressPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ([int]$result.launcherProcessId -eq $PID -and [int]$result.supervisorProcessId -eq $owner.Id) {
                        if ($result.phase -in @('ready', 'skipped', 'bridge-ready')) { return 0 }
                        if ($result.phase -in @('failed', 'cancelled')) {
                            [void]$owner.WaitForExit(10000)
                            return $(if ($result.phase -eq 'cancelled') { 0 } else { 1 })
                        }
                    }
                }
                catch { }
            }
            Start-Sleep -Milliseconds 250
        }
        return $owner.ExitCode
    }
    finally { $owner.Dispose() }
}

function Invoke-BridgeRetry {
    Write-LauncherProgress -Phase 'bridge-starting' -Summary 'Discord Bridge を再試行しています。' -ServerStatus '再確認中…' -DesktopStatus '再確認中…'
    Assert-LauncherNotCancelled
    $statusScript = Join-Path (Split-Path -Parent $launcherRoot) 'discord-bridge\Get-DiscordBridgeStatus.ps1'
    $stopScript = Join-Path (Split-Path -Parent $launcherRoot) 'discord-bridge\Stop-DiscordBridge.ps1'
    if (-not (Test-Path -LiteralPath $statusScript -PathType Leaf)) { throw 'Discord Bridge is not installed.' }
    $status = & $statusScript -Json | ConvertFrom-Json
    if ($status.ProcessAlive -and $status.DiscordReady -and $status.CodexConnected -and $status.AppServerReady) {
        Write-LauncherProgress -Phase 'bridge-ready' -Summary 'Discord Bridge はすでに接続済みです。再起動をスキップしました。' -ServerStatus '起動済み' -DesktopStatus '共有接続済み'
        return
    }
    if ($status.ProcessAlive -and $status.DiscordReady -and -not $status.AppServerReady) {
        throw 'Discord は接続済みですが、共有 App Server に接続できません。先に共有 App Server／Desktop を再試行してください。'
    }
    if ($status.ProcessAlive) {
        & $stopScript -TimeoutSeconds 30 | Out-Null
    }
    Assert-LauncherNotCancelled
    $task = Get-ScheduledTask -TaskName 'Codex Discord Remote' -ErrorAction Stop
    if ([string]$task.State -eq 'Running') {
        $deadline = [DateTimeOffset]::Now.AddSeconds(15)
        do {
            Assert-LauncherNotCancelled
            Start-Sleep -Milliseconds 250
            $task = Get-ScheduledTask -TaskName 'Codex Discord Remote' -ErrorAction Stop
        } while ([string]$task.State -eq 'Running' -and [DateTimeOffset]::Now -lt $deadline)
    }
    if ([string]$task.State -eq 'Running') { throw 'Discord Bridge のホストが終了しませんでした。強制終了は行っていません。' }
    Start-ScheduledTask -TaskName 'Codex Discord Remote'
    $deadline = [DateTimeOffset]::Now.AddMinutes(5)
    do {
        Assert-LauncherNotCancelled
        $status = & $statusScript -Json | ConvertFrom-Json
        if ($status.ProcessAlive -and $status.DiscordReady -and $status.CodexConnected -and $status.AppServerReady) {
            Write-LauncherProgress -Phase 'bridge-ready' -Summary 'Discord Bridge の接続を確認しました。' -ServerStatus '起動済み' -DesktopStatus '共有接続済み'
            return
        }
        Start-Sleep -Seconds 1
    } while ([DateTimeOffset]::Now -lt $deadline)
    throw "Discord Bridge の再試行が 5 分以内に完了しませんでした。$($status.AppServerStatus)"
}

if ($InteractiveWorker) {
    try { exit (Invoke-InteractiveLauncherWorker) }
    catch {
        Write-LauncherProgress -Phase 'failed' -Summary '起動操作を開始できませんでした。' -Detail $_.Exception.Message -ServerStatus '失敗' -DesktopStatus '未実行'
        exit 1
    }
}

try {
    Assert-LauncherNotCancelled
    Write-LauncherProgress -Phase 'preparing' -Summary 'インストール済みの Codex と共有サーバーを確認しています。'
    if ($RetryStep -eq 'Bridge') {
        Invoke-BridgeRetry
        exit 0
    }
    $packageInfo = Get-CodexPackageInfo
    Write-LauncherLog "Launcher started. mode=$modeName port=$Port package=$($packageInfo.Version)"

    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $codexAppToolsDefinition = Get-CodexAppToolsSharedDefinition `
        -LauncherRoot $launcherRoot `
        -NodeExecutable $nodeExecutable
    if (-not $SelfTest) {
        $configInstall = Install-CodexAppToolsSharedConfig `
            -LauncherRoot $launcherRoot `
            -NodeExecutable $nodeExecutable
        $codexAppToolsDefinition = $configInstall.Definition
        $codexAppToolsConfigPath = $configInstall.ConfigPath
        Write-LauncherLog (
            "Shared codex_app transport configuration verified. " +
            "changed=$($configInstall.Changed) path=$($configInstall.ConfigPath)"
        )
    }

    $existingDesktopRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $packageInfo.DesktopExecutable)
    if (-not $SelfTest -and $RetryStep -eq 'Desktop' -and $existingDesktopRoots.Count -gt 0) {
        $healthy = Get-ReusableRuntimeState -PackageInfo $packageInfo -PortNumber $Port -SuppressFailureLog
        if ($null -eq $healthy -or -not (Test-DesktopWebSocketConnection -DesktopExecutable $packageInfo.DesktopExecutable -PortNumber $Port)) {
            Write-LauncherProgress -Phase 'desktop-closing' -Summary '指定された Desktop の再試行を行うため、正常終了を要求しています。' -DesktopStatus '正常終了待ち…'
            foreach ($root in $existingDesktopRoots) {
                $live = Get-Process -Id $root.ProcessId -ErrorAction Stop
                if (-not $live.CloseMainWindow()) { throw 'Desktop が正常終了の要求を受け付けませんでした。Desktop を通常の操作で終了してから再試行してください。' }
            }
            $closeDeadline = [DateTimeOffset]::Now.AddSeconds(30)
            do {
                Assert-LauncherNotCancelled
                Start-Sleep -Milliseconds 250
                $existingDesktopRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $packageInfo.DesktopExecutable)
            } while ($existingDesktopRoots.Count -gt 0 -and [DateTimeOffset]::Now -lt $closeDeadline)
            if ($existingDesktopRoots.Count -gt 0) { throw 'Desktop はトレイ等に残っています。Desktop を通常の操作で完全に終了してから再試行してください。強制終了は行っていません。' }
        }
    }
    if (-not $SelfTest -and $existingDesktopRoots.Count -gt 0) {
        $processList = ($existingDesktopRoots.ProcessId -join ', ')
        $alreadyShared = Get-ReusableRuntimeState -PackageInfo $packageInfo -PortNumber $Port -SuppressFailureLog
        $sharedConnected = $null -ne $alreadyShared -and (Test-DesktopWebSocketConnection -DesktopExecutable $packageInfo.DesktopExecutable -PortNumber $Port)
        Write-LauncherLog "Desktop is already running; launch skipped. pid=$processList sharedConnected=$sharedConnected. No process was stopped."
        if ($sharedConnected) {
            Write-LauncherProgress -Phase 'skipped' -Summary 'すでに起動・共有接続済みのため、起動をスキップしました。' -ServerStatus '起動済み（スキップ）' -DesktopStatus '共有接続済み（スキップ）'
        }
        else {
            Write-LauncherProgress -Phase 'skipped' -Summary 'Desktop はすでに起動済みです。重複起動をスキップしました。' -Detail 'この Desktop の共有接続は確認できません。公式から直接起動している場合は、その作業を終えて Desktop を終了し、共有ランチャーで起動してください。' -ServerStatus '共有接続は未確認' -DesktopStatus '起動済み（スキップ）'
        }
        $exitCode = 0
        $startupHandled = $true
    }
    elseif (-not $SelfTest) {
        $reusableRuntime = Get-ReusableRuntimeState -PackageInfo $packageInfo -PortNumber $Port
        if ($null -ne $reusableRuntime) {
            Write-LauncherLog "Reusing healthy owned app-server. pid=$($reusableRuntime.serverProcessId)"
            $null = Start-DesktopOnRuntime `
                -PackageInfo $packageInfo `
                -RuntimeState $reusableRuntime `
                -PortNumber $Port
            Restore-RuntimeUpdateGoals `
                -WebSocketUrl $reusableRuntime.websocketUrl `
                -PackageVersion $packageInfo.Version
            Write-LauncherLog "Desktop attached to existing app-server. pid=$($reusableRuntime.serverProcessId)"
            Invoke-LauncherSignal -Kind Ready
            $exitCode = 0
            $startupHandled = $true
        }
    }

    if (-not $startupHandled) {
        $mutexName = "Local\CodexSharedServerLauncher-$Port"
        $mutex = [Threading.Mutex]::new($false, $mutexName)
        try {
            $ownsMutex = $mutex.WaitOne(0)
        }
        catch [Threading.AbandonedMutexException] {
            $ownsMutex = $true
        }
        if (-not $ownsMutex) {
            Write-LauncherProgress -Phase 'waiting-for-owner' -Summary '先に開始された共有ランチャーの完了を待っています。重複起動は行いません。'
            Write-LauncherLog (
                "Another launcher owns port $Port; waiting for its runtime to complete exact Desktop verification."
            )
            $concurrentRuntime = Wait-ReusableRuntimeState `
                -PackageInfo $packageInfo `
                -PortNumber $Port
            if ($null -eq $concurrentRuntime) {
                throw "Another Codex Shared Server launcher still owns port $Port, but its runtime did not become safely reusable."
            }
            Write-LauncherLog (
                "Concurrent launcher completed shared runtime verification. " +
                "pid=$($concurrentRuntime.serverProcessId)"
            )
            Invoke-LauncherSignal -Kind Ready
            Write-LauncherProgress -Phase 'ready' -Summary '先行ランチャーによる共有接続を確認しました。' -ServerStatus '起動済み（スキップ）' -DesktopStatus '共有接続済み'
            $exitCode = 0
            $startupHandled = $true
        }

        if (-not $startupHandled) {
            Assert-PortAvailable -PortNumber $Port

        $serverArguments = @(
            '-c',
            'features.code_mode_host=true',
            '-c',
            $codexAppToolsDefinition.Override,
            'app-server',
            '--listen',
            "ws://127.0.0.1:$Port",
            '--analytics-default-enabled'
        )
        $serverStartParameters = @{
            FilePath = $packageInfo.ServerExecutable
            ArgumentList = (@(
                $serverArguments |
                    ForEach-Object { ConvertTo-WindowsCommandLineArgument -Value ([string]$_) }
            ) -join ' ')
            WindowStyle = 'Hidden'
            RedirectStandardOutput = $serverStdoutPath
            RedirectStandardError = $serverStderrPath
            PassThru = $true
        }
        $serverProcess = Start-Process @serverStartParameters
        $serverProcessId = $serverProcess.Id

        $jobObject = [CodexSharedLauncher.KillOnCloseJob]::new()
        $jobObject.AddProcess($serverProcess)
        Write-LauncherLog "app-server started and assigned to job. pid=$serverProcessId"

        Wait-AppServerReady -Process $serverProcess -PortNumber $Port
        Write-LauncherLog "app-server ready. url=ws://127.0.0.1:$Port"
        Write-LauncherProgress -Phase 'server-ready' -Summary '共有 App Server は起動済みです。' -ServerStatus '起動済み'

        $runtimeState = [ordered]@{
            schemaVersion = 2
            mode = $modeName
            websocketUrl = "ws://127.0.0.1:$Port"
            readyUrl = "http://127.0.0.1:$Port/readyz"
            port = $Port
            serverProcessId = $serverProcessId
            supervisorProcessId = $PID
            desktopProcessIds = @()
            desktopConnectionVerified = $false
            packageVersion = $packageInfo.Version
            packageFamilyName = $packageInfo.PackageFamilyName
            desktopExecutable = $packageInfo.DesktopExecutable
            bundledServerExecutable = $packageInfo.BundledServerExecutable
            bundledCodeModeHostExecutable = $packageInfo.BundledCodeModeHostExecutable
            serverExecutable = $packageInfo.ServerExecutable
            serverSha256 = $packageInfo.ServerSha256
            codeModeHostExecutable = $packageInfo.CodeModeHostExecutable
            codeModeHostSha256 = $packageInfo.CodeModeHostSha256
            codexAppToolsTransportSchemaVersion = $codexAppToolsDefinition.SchemaVersion
            codexAppToolsBridgeScript = $codexAppToolsDefinition.BridgeScript
            codexAppToolsConfigPath = $codexAppToolsConfigPath
            startedAt = (Get-Date).ToString('o')
            logPath = $logPath
        }
        Write-RuntimeState -State $runtimeState

        if ($SelfTest) {
            $readyResponse = Invoke-WebRequest -UseBasicParsing -Uri $runtimeState.readyUrl -TimeoutSec 2
            if ($readyResponse.StatusCode -ne 200) {
                throw "Self-test ready endpoint returned HTTP $($readyResponse.StatusCode)."
            }
            & $nodeExecutable (Join-Path $launcherRoot 'verify-shared-connection.mjs') $runtimeState.websocketUrl | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Self-test failed during App Server initialization or thread/list.' }
            Write-LauncherLog 'SELFTEST_OK app-server accepted connections and returned HTTP 200.'
            Write-Output "SELFTEST_OK port=$Port serverPid=$serverProcessId log=$logPath"
            $exitCode = 0
        }
        else {
            $registeredWebSocketUrl = $runtimeState.websocketUrl
            $null = Start-DesktopOnRuntime `
                -PackageInfo $packageInfo `
                -RuntimeState $runtimeState `
                -PortNumber $Port
            Restore-RuntimeUpdateGoals `
                -WebSocketUrl $runtimeState.websocketUrl `
                -PackageVersion $packageInfo.Version
            Invoke-LauncherSignal -Kind Ready

            $monitoredDesktopVersion = $packageInfo.Version
            $monitoredDesktopExecutable = $packageInfo.DesktopExecutable
            $attemptedReplacementKey = $null
            $missingSince = $null
            while ($true) {
                $currentRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $monitoredDesktopExecutable)
                if ($currentRoots.Count -gt 0) {
                    $missingSince = $null
                }
                else {
                    $replacement = $null
                    try {
                        $replacement = Get-CodexDesktopPackageReplacement `
                            -CurrentVersion $monitoredDesktopVersion `
                            -CurrentDesktopExecutable $monitoredDesktopExecutable
                    }
                    catch {
                        Write-LauncherLog "Unable to inspect a possible Desktop package replacement: $($_.Exception.Message)"
                    }

                    if ($null -ne $replacement) {
                        $replacementKey = "$($replacement.Version)|$($replacement.DesktopExecutable)"
                        if ($replacementKey -ne $attemptedReplacementKey) {
                            $attemptedReplacementKey = $replacementKey
                            Write-LauncherLog (
                                "Desktop package replacement detected. " +
                                "oldVersion=$monitoredDesktopVersion newVersion=$($replacement.Version)"
                            )
                            Wait-RuntimeUpdateQuiescence `
                                -WebSocketUrl $runtimeState.websocketUrl `
                                -FromVersion $monitoredDesktopVersion `
                                -ToVersion $replacement.Version
                            $restartAfterCleanup = $true
                            $replacementPackageVersion = $replacement.Version
                            Write-LauncherLog (
                                "Updated Desktop and shared app-server will restart together. " +
                                "version=$replacementPackageVersion"
                            )
                            break
                        }
                    }

                    if ($null -eq $missingSince) {
                        $missingSince = Get-Date
                    }
                    elseif (((Get-Date) - $missingSince).TotalSeconds -ge 60) {
                        break
                    }
                }
                Start-Sleep -Seconds 1
            }

            if ($restartAfterCleanup) {
                Write-LauncherLog 'Runtime update drain completed; beginning old shared app-server cleanup.'
            }
            else {
                Write-LauncherLog 'Desktop exited; beginning owned app-server cleanup.'
            }
            $exitCode = 0
        }
        }
    }
}
catch {
    Write-LauncherLog "ERROR $($_.Exception.Message)"
    if ($_.Exception -is [OperationCanceledException]) {
        foreach ($root in $launchedDesktopRoots) {
            try { [void](Get-Process -Id $root.ProcessId -ErrorAction Stop).CloseMainWindow() } catch { }
        }
        Write-LauncherProgress -Phase 'cancelled' -Summary '起動操作を中止しました。' -ServerStatus '中止' -DesktopStatus '中止'
    }
    else {
        Write-LauncherProgress -Phase 'failed' -Summary '共有起動を完了できませんでした。' -Detail $_.Exception.Message -ServerStatus '失敗／停止' -DesktopStatus '共有接続失敗'
    }
    if (-not $SelfTest) {
        Invoke-LauncherSignal -Kind Error
        Show-LauncherMessage -Message "Codex Shared Server could not complete startup.`n`n$($_.Exception.Message)`n`nLog:`n$logPath" -Icon 16
    }
    else {
        Write-Error $_
    }
    $exitCode = 1
}
finally {
    if ($null -ne $registeredWebSocketUrl) {
        try {
            Clear-UserWebSocketEnvironment -ExpectedWebSocketUrl $registeredWebSocketUrl
            Write-LauncherLog 'Transient user WebSocket environment removed.'
        }
        catch {
            Write-LauncherLog "Unable to remove transient user environment: $($_.Exception.Message)"
        }
    }

    if ($serverProcessId -ne 0) {
        Remove-RuntimeStateIfOwned -ExpectedServerProcessId $serverProcessId
    }

    if ($null -ne $jobObject) {
        Write-LauncherLog "Closing owned app-server job. pid=$serverProcessId"
        $jobObject.Dispose()
        if ($null -ne $serverProcess) {
            try {
                [void]$serverProcess.WaitForExit(5000)
                Write-LauncherLog "Owned app-server stopped. exited=$($serverProcess.HasExited)"
            }
            catch {
                Write-LauncherLog "Unable to confirm app-server exit: $($_.Exception.Message)"
            }
        }
    }
    elseif ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        # This fallback applies only to the exact process created by this invocation.
        Write-LauncherLog "Job assignment failed; stopping exact owned process. pid=$serverProcessId"
        Stop-Process -Id $serverProcessId -Force -ErrorAction SilentlyContinue
    }

    if ($ownsMutex -and $null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }

    if (-not $SelfTest -and $exitCode -eq 0 -and $serverProcessId -ne 0 -and -not $restartAfterCleanup) {
        Invoke-LauncherSignal -Kind Stopped
    }
    Write-LauncherLog "Launcher finished. exitCode=$exitCode"
}

if (-not $SelfTest -and $exitCode -eq 0 -and $restartAfterCleanup) {
    try {
        if (-not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) {
            throw "Shared launcher executable was not found: $launcherExecutable"
        }
        Start-Process `
            -FilePath $launcherExecutable `
            -ArgumentList '--no-dialogs' `
            -WindowStyle Hidden | Out-Null
        Write-LauncherLog (
            "Replacement shared launcher started after runtime cleanup. " +
            "targetVersion=$replacementPackageVersion"
        )
    }
    catch {
        Write-LauncherLog "Unable to start replacement shared launcher: $($_.Exception.Message)"
        Invoke-LauncherSignal -Kind Error
        $exitCode = 1
    }
}

exit $exitCode
