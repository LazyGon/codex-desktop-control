[CmdletBinding()]
param([Parameter(Mandatory)][string]$RequestPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexRuntimeHandoff.ps1')
. (Join-Path $PSScriptRoot 'CodexDesktopPackage.ps1')
. (Join-Path $PSScriptRoot 'CodexRuntimeCache.ps1')
. (Join-Path $PSScriptRoot 'CodexDesktopStartup.ps1')

$stateRoot = Join-Path $PSScriptRoot 'state'
$handoffs = Join-Path $stateRoot 'runtime-handoffs'
$directory = Split-Path -Parent ([IO.Path]::GetFullPath($RequestPath))
$id = Split-Path -Leaf $directory
if ((Split-Path -Parent $directory) -ne $handoffs -or (Split-Path -Leaf $RequestPath) -ne 'request.json' -or
    $id -notmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') {
    throw 'Use the recorded local handoff request.'
}
$request = Read-CodexHandoffJson (Join-Path $directory 'request.json')
if (-not $request -or $request.id -ne $id -or $request.port -lt 1024 -or $request.port -gt 65535) {
    throw 'The handoff request is missing or does not match its recorded identity.'
}
$browserAccessTrial = [bool]($request.PSObject.Properties['desktopBrowserAccessTrial'] -and
    $request.desktopBrowserAccessTrial -eq $true)
if ($browserAccessTrial) {
    Assert-CodexDesktopBrowserAccessTrialVersion $request.fromVersion
    Assert-CodexDesktopBrowserAccessTrialVersion $request.toVersion
}
$port = [int]$request.port
$endpoint = "ws://127.0.0.1:$port"
$readyUrl = "http://127.0.0.1:$port/readyz"
$canonical = Join-Path $stateRoot 'current.json'
$progress = Join-Path $directory 'startup.json'
$resultPath = Join-Path $directory 'result.json'
$bridgeStatus = Join-Path (Split-Path -Parent $PSScriptRoot) 'discord-bridge/Get-DiscordBridgeStatus.ps1'

function Save-HandoffResult {
    param([string]$Phase, [string]$Detail = '')
    $result.phase = $Phase
    $result.detail = $Detail
    $result.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-CodexHandoffJson $resultPath $result
}

function Get-ReplacementConnections {
    param([int]$ProcessId)
    Get-NetTCPConnection -State Established -RemotePort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.RemoteAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $ProcessId }
}

function Get-VerifiedReplacement {
    $live = Read-CodexHandoffJson $canonical
    if (-not $live -or $live.port -ne $port -or $live.websocketUrl -ne $endpoint -or
        $live.packageVersion -ne $request.toVersion -or $live.desktopExecutable -ne $request.desktop -or
        -not $live.desktopConnectionVerified) { return }
    $server = Get-Process -Id $live.serverProcessId -ErrorAction SilentlyContinue
    $supervisor = Get-Process -Id $live.supervisorProcessId -ErrorAction SilentlyContinue
    if (-not $server -or -not $supervisor -or $server.Path -ne $live.serverExecutable) { return }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $server.Id) { return }
    $peer = Get-CodexHandoffDesktopProcesses | Where-Object { $_.Path -eq $request.desktop -and (Get-ReplacementConnections $_.Id) } | Select-Object -First 1
    if (-not $peer) { return }
    try { if ((Invoke-WebRequest -UseBasicParsing -Uri $readyUrl -TimeoutSec 3).StatusCode -ne 200) { return } }
    catch { return }
    if ($live.serverSha256 -ne $request.serverSha256 -or (Get-CodexFileSha256 $server.Path) -ne $request.serverSha256) {
        throw 'The live server does not match the registered Desktop bundle.'
    }
    $liveBrowserAccessTrial = [bool]($live.PSObject.Properties['desktopBrowserAccessTrial'] -and
        $live.desktopBrowserAccessTrial -eq $true)
    if ($liveBrowserAccessTrial -ne $browserAccessTrial) {
        throw 'The verified runtime was started with a different Desktop browser access mode. It was left running.'
    }
    @{
        server = Get-CodexHandoffActor $server
        supervisor = Get-CodexHandoffActor $supervisor
        desktop = Get-CodexHandoffActor $peer
        serverSha256 = $live.serverSha256
    }
}

$mutex = [Threading.Mutex]::new($false, "Local\CodexSharedRuntimeHandoff-$id")
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { return }

    $previous = Read-CodexHandoffJson $resultPath
    if ($previous -and $previous.phase -in @('verified', 'cancelled')) { return }
    $result = [ordered]@{
        id = $id; fromVersion = $request.fromVersion; toVersion = $request.toVersion
        bridgeWasRunning = $request.bridgeWasRunning
        desktopBrowserAccessTrial = $browserAccessTrial
        launchRequestedAt = if ($previous) { $previous.launchRequestedAt } else { $null }
        launchActor = if ($previous -and $previous.PSObject.Properties['launchActor']) { $previous.launchActor } else { $null }
    }
    Save-HandoffResult 'armed'

    while ((Test-CodexHandoffActorAlive $request.oldSupervisor) -or (Test-CodexHandoffActorAlive $request.oldServer)) {
        $drain = Read-CodexHandoffJson (Join-Path $directory 'drain.json')
        if ($drain -and $drain.phase -eq 'cancelled') { Save-HandoffResult 'cancelled' $drain.reason; return }
        Start-Sleep -Seconds 1
    }
    $drain = Read-CodexHandoffJson (Join-Path $directory 'drain.json')
    if (-not (Test-CodexHandoffExitAccepted $request $drain)) {
        throw 'The old AppServer did not record a clean exit. No replacement was started.'
    }

    $package = Get-CodexDesktopPackageInfo -RequireBundledRuntime -RequireTrustedRegistration
    if ($package.Version -ne $request.toVersion -or $package.PackageFamilyName -ne $request.family -or
        $package.DesktopExecutable -ne $request.desktop -or (Get-CodexFileSha256 $package.BundledServerExecutable) -ne $request.serverSha256) {
        throw 'The registered Desktop changed during handoff. Open the shared launcher to use the currently registered version.'
    }

    $live = Get-VerifiedReplacement
    $child = $null
    try {
        if (-not $live -and -not $result.launchRequestedAt) {
            $candidate = Read-CodexHandoffJson $canonical
            $otherListener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
            if (-not $otherListener -and -not (Get-CodexHandoffDesktopProcesses) -and
                (-not $candidate -or -not (Get-Process -Id $candidate.supervisorProcessId -ErrorAction SilentlyContinue))) {
                # Persist before launch. A restarted worker may adopt the actual
                # replacement, but never repeats a launch with unknown outcome.
                $result.launchRequestedAt = [DateTimeOffset]::UtcNow.ToString('o')
                Save-HandoffResult 'launch-requested'
                $startup = Join-Path $PSScriptRoot 'Start-CodexShared.ps1'
                $startupArguments = '"{0}" -Port {1} -NoDialogs -RuntimeSupervisor -ProgressPath "{2}" -DesktopConnectionStallSeconds {3}' -f
                    $startup, $port, $progress, $request.startupStallSeconds
                if ($browserAccessTrial) { $startupArguments += ' -DesktopBrowserAccessTrial' }
                $child = Start-CodexHandoffChild $startupArguments
                try { $result.launchActor = Get-CodexHandoffActor $child }
                catch { if (-not $child.HasExited) { throw } }
                Save-HandoffResult 'starting'
            }
        }

        $watch = [Diagnostics.Stopwatch]::StartNew()
        $lastProgress = $null
        while (-not $live) {
            $now = Read-CodexHandoffJson $progress
            if ($now -and $now.updatedAt -ne $lastProgress) {
                $lastProgress = $now.updatedAt
                $watch.Restart()
            }
            $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
            $startupAlive = ($result.launchActor -and (Test-CodexHandoffActorAlive $result.launchActor)) -or $listener
            if (($child -and $child.HasExited) -or (-not $child -and -not $startupAlive) -or
                ($now -and $now.phase -in @('failed', 'cancelled')) -or ($request.startupStallSeconds -gt 0 -and
                    $watch.Elapsed.TotalSeconds -ge $request.startupStallSeconds)) {
                $live = Get-VerifiedReplacement
                if (-not $live) { throw 'No verified replacement is connected. Inspect startup.json; the handoff will not repeat an uncertain launch.' }
                break
            }
            Start-Sleep -Seconds 1
            $live = Get-VerifiedReplacement
        }
    }
    finally { if ($child) { $child.Dispose() } }

    $result.runtime = $live
    if ($request.bridgeWasRunning) {
        Save-HandoffResult 'desktop-ready' 'Waiting for Discord Bridge to reconnect.'
        $watch = [Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            $bridge = & $bridgeStatus -Json | ConvertFrom-Json
            if ($bridge.ProcessAlive -and $bridge.HostProcessAlive -and $bridge.DiscordReady -and
                $bridge.DiscordGatewayState -eq 'ready' -and $bridge.CodexConnected -and $bridge.AppServerReady -and
                $bridge.Endpoint -eq $endpoint -and (Get-ReplacementConnections $bridge.Pid)) {
                $result.bridgePid = $bridge.Pid
                break
            }
            if (-not $bridge.ProcessAlive -or ($request.startupStallSeconds -gt 0 -and
                    $watch.Elapsed.TotalSeconds -ge $request.startupStallSeconds)) {
                Save-HandoffResult 'desktop-ready' 'Desktop and AppServer are connected; Discord Bridge has not yet been verified. Recheck the same handoff task without relaunching Desktop.'
                return
            }
            Start-Sleep -Seconds 2
        }
    }
    Save-HandoffResult 'verified'
}
catch {
    if ($owned -and (Get-Variable result -ErrorAction SilentlyContinue)) {
        Save-HandoffResult 'failed' $_.Exception.Message
    }
    throw
}
finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
