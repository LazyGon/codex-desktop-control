[CmdletBinding()]
param(
    [ValidatePattern('^\d{15,22}$')]
    [string]$ApplicationId,

    [ValidatePattern('^\d{15,22}$')]
    [string]$GuildId,

    [ValidatePattern('^\d{15,22}$')]
    [string]$AuthorizedUserId,

    # Legacy compatibility. Only the first value is used when
    # -AuthorizedUserId is omitted.
    [ValidatePattern('^\d{15,22}$')]
    [string[]]$AllowedUserIds,

    [ValidatePattern('^\d{15,22}$')]
    [string]$CompletionMentionUserId,

    [Security.SecureString]$BotToken,

    [ValidateRange(1024, 65535)]
    [int]$Port = 8798,

    [switch]$EnablePlainMessageInput,
    [switch]$SkipScheduledTask,
    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$launcherRoot = Join-Path $root 'launcher'
$bridgeRoot = Join-Path $root 'discord-bridge'
$launcherInstaller = Join-Path $launcherRoot 'Install-CodexSharedLauncher.ps1'
$launcherExecutable = Join-Path $launcherRoot 'CodexSharedLauncher.exe'
$launcherStatePath = Join-Path $launcherRoot 'state\current.json'
$bridgeInstaller = Join-Path $bridgeRoot 'Install-DiscordBridge.ps1'
$bridgeStartScript = Join-Path $bridgeRoot 'Start-DiscordBridge.ps1'
$bridgeStopScript = Join-Path $bridgeRoot 'Stop-DiscordBridge.ps1'
$bridgeLockPath = Join-Path $bridgeRoot 'data\bridge.lock'
$bridgeRuntimePath = Join-Path $bridgeRoot 'data\runtime.json'
$expectedWebSocketUrl = "ws://127.0.0.1:$Port"
$taskName = 'Codex Discord Remote'

foreach ($requiredPath in @($launcherInstaller, $bridgeInstaller, $bridgeStartScript, $bridgeStopScript)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required installer component was not found: $requiredPath"
    }
}

function Test-ProcessAlive {
    param([object]$ProcessId)

    $parsed = 0
    if ($null -eq $ProcessId -or -not [int]::TryParse([string]$ProcessId, [ref]$parsed)) {
        return $false
    }
    return $null -ne (Get-Process -Id $parsed -ErrorAction SilentlyContinue)
}

function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-SharedDesktopReady {
    $state = Read-JsonFile -Path $launcherStatePath
    if ($null -eq $state -or $state.websocketUrl -ne $expectedWebSocketUrl) {
        return $false
    }
    if ($state.desktopConnectionVerified -ne $true) {
        return $false
    }
    if (-not (Test-ProcessAlive -ProcessId $state.supervisorProcessId)) {
        return $false
    }
    if (-not (Test-ProcessAlive -ProcessId $state.serverProcessId)) {
        return $false
    }
    return @($state.desktopProcessIds | Where-Object { Test-ProcessAlive -ProcessId $_ }).Count -gt 0
}

function Test-BridgeReady {
    $runtime = Read-JsonFile -Path $bridgeRuntimePath
    if ($null -eq $runtime -or $runtime.phase -ne 'running' -or $runtime.discordReady -ne $true) {
        return $false
    }
    if ($null -eq $runtime.codex) {
        return $false
    }
    if (-not (Test-ProcessAlive -ProcessId $runtime.pid)) {
        return $false
    }
    return $runtime.codex.connected -eq $true -and $runtime.codex.endpoint -eq $expectedWebSocketUrl
}

function Wait-Until {
    param(
        [Parameter(Mandatory)][scriptblock]$Condition,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][string]$FailureMessage
    )

    $deadline = [DateTimeOffset]::Now.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw $FailureMessage
}

function Start-BridgeProcess {
    if (-not $SkipScheduledTask) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -eq $task) {
            throw "Scheduled Task was not installed: $taskName"
        }
        Start-ScheduledTask -TaskName $taskName
        return
    }

    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $bridgeStartScript
    ) | Out-Null
}

$bridgeWasRunning = $false
if (Test-Path -LiteralPath $bridgeLockPath -PathType Leaf) {
    $bridgePidText = (Get-Content -LiteralPath $bridgeLockPath -Raw).Trim()
    $bridgeWasRunning = Test-ProcessAlive -ProcessId $bridgePidText
}
if ($bridgeWasRunning) {
    & $bridgeStopScript | Out-Host
}

try {
    & $launcherInstaller -Port $Port | Out-Host

    $bridgeParameters = @{
        NoStart = $true
        SkipScheduledTask = [bool]$SkipScheduledTask
        EnablePlainMessageInput = [bool]$EnablePlainMessageInput
    }
    foreach ($name in @('ApplicationId', 'GuildId', 'AuthorizedUserId', 'AllowedUserIds', 'CompletionMentionUserId', 'BotToken')) {
        if ($PSBoundParameters.ContainsKey($name)) {
            $bridgeParameters[$name] = $PSBoundParameters[$name]
        }
    }
    & $bridgeInstaller @bridgeParameters | Out-Host

    if (-not $NoStart) {
        if (-not (Test-SharedDesktopReady)) {
            Start-Process -FilePath $launcherExecutable -WorkingDirectory $launcherRoot | Out-Null
            Wait-Until -TimeoutSeconds 90 -Condition { Test-SharedDesktopReady } -FailureMessage (
                'Codex Desktop did not connect to the shared app-server within 90 seconds. ' +
                'If Desktop was already open through its normal shortcut, quit it normally and run Install.ps1 again.'
            )
        }

        Start-BridgeProcess
        Wait-Until -TimeoutSeconds 90 -Condition { Test-BridgeReady } -FailureMessage (
            'Discord Bridge did not connect to Discord and the shared app-server within 90 seconds. ' +
            'Run discord-bridge\Get-DiscordBridgeStatus.ps1 and inspect discord-bridge\logs.'
        )
    }
}
catch {
    if ($bridgeWasRunning -and -not (Test-BridgeReady)) {
        try {
            Start-BridgeProcess
        }
        catch {}
    }
    throw
}

[pscustomobject]@{
    Installed = $true
    Root = $root
    SharedLauncher = $launcherExecutable
    SharedWebSocketUrl = $expectedWebSocketUrl
    DesktopUiSynchronized = if ($NoStart) { $false } else { Test-SharedDesktopReady }
    DiscordBridgeReady = if ($NoStart) { $false } else { Test-BridgeReady }
    ScheduledTask = if ($SkipScheduledTask) { 'Skipped' } else { $taskName }
    Started = -not $NoStart
}
