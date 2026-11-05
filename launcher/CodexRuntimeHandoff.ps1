function Read-CodexHandoffJson {
    param([string]$Path)
    if (-not [IO.File]::Exists($Path)) { return }
    $stream = [IO.File]::Open($Path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $reader = [IO.StreamReader]::new($stream)
        try { $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Write-CodexHandoffJson {
    param([string]$Path, [object]$Value)
    $suffix = [guid]::NewGuid().ToString('N')
    $temp = "$Path.$suffix.tmp"
    $backup = "$Path.$suffix.bak"
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 8))
        $stream = [IO.File]::Open($temp, 'CreateNew', 'Write', 'None')
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temp, $Path, $backup) }
        else { [IO.File]::Move($temp, $Path) }
    }
    finally {
        [IO.File]::Delete($temp)
        [IO.File]::Delete($backup)
    }
}

function Get-CodexHandoffActor {
    param([Diagnostics.Process]$Process)
    @{
        pid = $Process.Id
        executable = $Process.Path
        startedUtcTicks = $Process.StartTime.ToUniversalTime().Ticks.ToString()
    }
}

function Test-CodexHandoffActorAlive {
    param([object]$Actor)
    $process = Get-Process -Id $Actor.pid -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    try {
        if ($process.HasExited) { return $false }
        return $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $Actor.startedUtcTicks
    }
    catch {
        # Cannot distinguish access denied from the admitted process still running.
        if ($process.HasExited) { return $false }
        throw
    }
    finally { $process.Dispose() }
}

function Get-CodexHandoffDesktopProcesses {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session
}

function Test-CodexManualRefreshActive {
    $mutex = [Threading.Mutex]::new($false, 'Local\CodexSharedRuntimeRefreshController')
    try {
        try { $free = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $free = $true }
        if ($free) { $mutex.ReleaseMutex() }
        return -not $free
    }
    finally { $mutex.Dispose() }
}

function Start-CodexHandoffChild {
    param([string]$Arguments)
    $executable = Join-Path $PSHOME $(if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' })
    $info = [Diagnostics.ProcessStartInfo]::new($executable, "-NoLogo -NoProfile -NonInteractive -File $Arguments")
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    [Diagnostics.Process]::Start($info)
}

function Request-CodexAppServerShutdown {
    param([Diagnostics.Process]$Server, [string]$ResultPath)
    $actor = Get-CodexHandoffActor $Server
    $sender = Join-Path $PSScriptRoot 'Send-CodexAppServerShutdown.ps1'
    $child = Start-CodexHandoffChild ('"{0}" -ServerId {1} -Executable "{2}" -StartedUtcTicks {3} -ResultPath "{4}"' -f
        $sender, $actor.pid, $actor.executable, $actor.startedUtcTicks, $ResultPath)
    try {
        $child.WaitForExit()
        if ($child.ExitCode -ne 0) {
            $detail = if ([IO.File]::Exists($ResultPath)) { [IO.File]::ReadAllText($ResultPath) } else { 'Sender exited without a receipt.' }
            throw "AppServer shutdown signal could not be verified: $detail"
        }
    }
    finally { $child.Dispose() }
}

function Assert-CodexGracefulShutdownSupported {
    param([Diagnostics.Process]$Server)
    $reported = (& $Server.Path --version | Select-Object -Last 1)
    if ($LASTEXITCODE -eq 0 -and $reported -match '^codex-cli (?<release>\d+\.\d+\.\d+)(?:-(?<prerelease>[\w.-]+))?(?:\+[^ ]+)?$') {
        $release = [version]$Matches.release
        $prerelease = $Matches['prerelease']
        # 0.166.0-alpha.5.1 is the oldest bundled Windows runtime verified
        # here to handle one CTRL+C by closing admission and draining turns.
        if ($release -gt [version]'0.166.0') { return }
        if ($release -eq [version]'0.166.0') {
            if (-not $prerelease) { return }
            if ($prerelease -match '^alpha\.(?<build>\d+)(?:\.(?<revision>\d+))?$') {
                if ([int]$Matches.build -gt 5 -or ([int]$Matches.build -eq 5 -and [int]$Matches['revision'] -ge 1)) { return }
            }
        }
    }
    throw 'This AppServer version has no verified Windows graceful shutdown. It was left running.'
}

function New-CodexRuntimeHandoff {
    param(
        [string]$StateRoot, [object]$Runtime, [Diagnostics.Process]$Server,
        [object]$Target, [int]$StartupStallSeconds
    )
    $id = [guid]::NewGuid().ToString()
    $directory = Join-Path (Join-Path $StateRoot 'runtime-handoffs') $id
    $null = New-Item -Path $directory -ItemType Directory
    $requestPath = Join-Path $directory 'request.json'
    $bridge = Join-Path (Split-Path -Parent $PSScriptRoot) 'discord-bridge/Get-DiscordBridgeStatus.ps1'
    $bridgeRunning = (Test-Path -LiteralPath $bridge) -and ((& $bridge -Json | ConvertFrom-Json).ProcessAlive -eq $true)
    $request = [ordered]@{
        id = $id; port = $Runtime.port; fromVersion = $Runtime.packageVersion; toVersion = $Target.Version
        desktop = $Target.DesktopExecutable; family = $Target.PackageFamilyName; serverSha256 = $Target.ServerSha256
        oldServer = Get-CodexHandoffActor $Server
        oldSupervisor = Get-CodexHandoffActor ([Diagnostics.Process]::GetCurrentProcess())
        bridgeWasRunning = $bridgeRunning; startupStallSeconds = $StartupStallSeconds
    }
    Write-CodexHandoffJson $requestPath $request
    $worker = Join-Path $PSScriptRoot 'Complete-CodexRuntimeHandoff.ps1'
    $name = "Codex Shared Runtime Handoff $id"
    $shell = Join-Path $PSHOME $(if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' })
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -RequestPath "{1}"' -f $worker, $requestPath
    $action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $PSScriptRoot
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null = Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings
    $task = Get-ScheduledTask -TaskName $name
    $sid = ([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
    if (@($task.Actions).Count -ne 1 -or $task.Actions.Execute -ne $shell -or $task.Actions.Arguments -ne $arguments -or
        $task.Actions.WorkingDirectory -ne $PSScriptRoot -or $task.Principal.LogonType -ne 'Interactive' -or
        $task.Principal.RunLevel -ne 'Limited' -or $sid -ne $identity.User.Value -or @($task.Triggers | Where-Object { $_ }).Count) {
        throw 'The handoff task registration differs from its intended action or principal.'
    }
    try {
        $lastRun = (Get-ScheduledTaskInfo -TaskName $name).LastRunTime
        Start-ScheduledTask -TaskName $name
        $watch = [Diagnostics.Stopwatch]::StartNew()
        do {
            $result = Read-CodexHandoffJson (Join-Path $directory 'result.json')
            if ($result -and $result.phase -eq 'armed') { return $directory }
            if ($result -and $result.phase -eq 'failed') { throw $result.detail }
            $state = (Get-ScheduledTask -TaskName $name).State
            if ($state -ne 'Running' -and (Get-ScheduledTaskInfo -TaskName $name).LastRunTime -ne $lastRun) {
                $result = Read-CodexHandoffJson (Join-Path $directory 'result.json')
                if ($result -and $result.phase -eq 'armed') { throw 'The armed handoff worker already exited.' }
                throw 'The scheduled handoff exited before arming.'
            }
            Start-Sleep -Milliseconds 250
        } while ($StartupStallSeconds -eq 0 -or $watch.Elapsed.TotalSeconds -lt $StartupStallSeconds)
        throw "Handoff task did not arm. Receipt: $directory"
    }
    catch {
        Write-CodexHandoffJson (Join-Path $directory 'drain.json') @{ phase = 'cancelled'; reason = $_.Exception.Message }
        throw
    }
}

function Wait-CodexDesktopRuntimeExit {
    param(
        [object]$Runtime, [Diagnostics.Process]$Server, [string]$StateRoot,
        [string]$CacheRoot, [int]$StartupStallSeconds, [scriptblock]$Log
    )
    $absent = $null
    $lastError = $null
    $shutdownRequested = $false
    $handoff = $null
    while (-not $Server.HasExited) {
        try {
            if (-not $shutdownRequested) {
                if (Get-CodexHandoffDesktopProcesses) {
                    $absent = $null
                }
                else {
                    if (-not $absent) { $absent = [Diagnostics.Stopwatch]::StartNew() }
                    $packageQuery = @{
                        CurrentVersion = $Runtime.packageVersion
                        CurrentDesktopExecutable = $Runtime.desktopExecutable
                        RequireTrustedRegistration = $true
                    }
                    $manualRefresh = Test-CodexManualRefreshActive
                    $target = if (-not $manualRefresh) { Get-CodexDesktopPackageReplacement @packageQuery }
                    if ($target) {
                        if ($target.PackageFamilyName -ne $Runtime.packageFamilyName -or
                            [version]$target.Version -le [version]$Runtime.packageVersion) {
                            throw 'The registered replacement is not a newer release of the same Desktop package.'
                        }
                        $target = Get-CodexPackageRuntime -Package $target -CacheRoot $CacheRoot
                        if (-not (Get-CodexHandoffDesktopProcesses)) {
                            # Do not create another job if registration has an uncertain result.
                            $shutdownRequested = $true
                            if (-not $Runtime.appServerGracefulShutdown) { throw 'The current AppServer does not have verified graceful shutdown support.' }
                            $handoff = New-CodexRuntimeHandoff $StateRoot $Runtime $Server $target $StartupStallSeconds
                            & $Log "Runtime handoff armed: $handoff"
                            if (Get-CodexHandoffDesktopProcesses) {
                                Write-CodexHandoffJson (Join-Path $handoff 'drain.json') @{ phase = 'cancelled'; reason = 'Desktop reopened before shutdown.' }
                                $shutdownRequested = $false
                                $handoff = $null
                                continue
                            }
                        }
                    }
                    elseif ($manualRefresh -or $absent.Elapsed.TotalSeconds -ge 60) {
                        $shutdownRequested = $true
                        if (-not $Runtime.appServerGracefulShutdown) { throw 'The current AppServer does not have verified graceful shutdown support.' }
                    }

                    if ($shutdownRequested) {
                        $signalResult = Join-Path $StateRoot "appserver-shutdown-$($Server.Id).txt"
                        if ($handoff) {
                            Write-CodexHandoffJson (Join-Path $handoff 'drain.json') @{ phase = 'shutdown-requested' }
                            $signalResult = Join-Path $handoff 'shutdown.txt'
                        }
                        & $Log 'Requesting one graceful shutdown of the owned AppServer.'
                        Request-CodexAppServerShutdown $Server $signalResult
                    }
                }
            }
        }
        catch {
            if ($_.Exception.Message -ne $lastError) {
                $lastError = $_.Exception.Message
                & $Log "Shared AppServer preserved: $lastError"
            }
            # An uncertain signal must never fall through to job disposal while
            # the server is alive, nor be retried. If it exits, read the result.
        }
        [void]$Server.WaitForExit(1000)
    }
    if ($handoff) {
        Write-CodexHandoffJson (Join-Path $handoff 'drain.json') @{ phase = 'exited'; exitCode = $Server.ExitCode }
    }
    [pscustomobject]@{ Handoff = $handoff; ExitCode = $Server.ExitCode }
}
