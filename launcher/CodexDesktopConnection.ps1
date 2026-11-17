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
        $serverOnly = $state.PSObject.Properties['mode'] -and $state.mode -eq 'server'
        if ($state.desktopConnectionVerified -ne $true -and -not $serverOnly) {
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
            $supervisor.CommandLine -notmatch [regex]::Escape((Join-Path $PSScriptRoot 'Start-CodexShared.ps1'))
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
        [Parameter(Mandatory)][int]$OwnedServerProcessId,
        [int]$TimeoutSeconds = 0,
        [int]$PollMilliseconds = 500
    )

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $helperLogged = $false
    $lastProgressSeconds = 0.0
    $lastStage = 0
    $progressOffsets = @{}
    $sharedHandshakeByDesktop = @{}
    while ($true) {
        Assert-LauncherNotCancelled
        $roots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $PackageInfo.DesktopExecutable)
        if ($roots.Count -gt 0) {
            $stage = Read-CodexDesktopStartupProgress -DesktopRoots $roots -Offsets $progressOffsets -PackageInfo $PackageInfo -SharedHandshakeByDesktop $sharedHandshakeByDesktop
            if ($stage -gt $lastStage) {
                $lastStage = $stage
                $lastProgressSeconds = $watch.Elapsed.TotalSeconds
                Write-LauncherLog "Desktop forward startup progress observed. stage=$lastStage totalSeconds=$([int]$watch.Elapsed.TotalSeconds)"
                Write-LauncherProgress -Phase 'desktop-connecting' -Summary 'Desktop の初期化が進んでいます。進捗が続く間は接続を待ちます。' -Detail "確認済み段階: $lastStage。進捗停止の確認時間: $TimeoutSeconds 秒。" -ServerStatus '起動済み' -DesktopStatus '初期化進行中…'
            }
        }
        $desktopInitialized = @($roots | Where-Object {
            $started = [DateTimeOffset]$_.CreationDate
            $sharedHandshakeByDesktop["$($_.ProcessId)|$($started.UtcDateTime.Ticks)"] -eq 'local-connected'
        }).Count -gt 0
        $sharedSocket = Test-DesktopWebSocketConnection -DesktopExecutable $PackageInfo.DesktopExecutable -PortNumber $PortNumber
        $ownedServer = Get-Process -Id $OwnedServerProcessId -ErrorAction SilentlyContinue
        $decision = Get-CodexDesktopConnectionDecision `
            -Connected ($desktopInitialized -and $sharedSocket) `
            -ServerAlive ($null -ne $ownedServer -and -not $ownedServer.HasExited) `
            -DesktopAlive ($roots.Count -gt 0) -Cancelled $false `
            -ElapsedSeconds ($watch.Elapsed.TotalSeconds - $lastProgressSeconds) -TimeoutSeconds $TimeoutSeconds
        if ($decision -eq 'ready') {
            return $true
        }
        if (-not $helperLogged) {
            $rootIds = @($roots | ForEach-Object { [int]$_.ProcessId })
            $helpers = @(Get-DesktopLocalAppServers -DesktopRootProcessIds $rootIds)
            if ($helpers.Count -gt 0) {
                Write-LauncherLog "Desktop bootstrap stdio helper observed; continuing to wait for its shared WebSocket. pid=$($helpers.ProcessId -join ',')"
                $helperLogged = $true
            }
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
}

function Resolve-ExistingDesktopStartup {
    param(
        [Parameter(Mandatory)][object]$PackageInfo,
        [Parameter(Mandatory)][int]$PortNumber,
        [switch]$ServerOnly,
        [switch]$RetryDesktop,
        [switch]$DesktopBrowserAccessTrial
    )

    $roots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $PackageInfo.DesktopExecutable)
    if ($DesktopBrowserAccessTrial -and $roots.Count -gt 0) {
        throw 'Desktop is already running. Its launch settings were not changed.'
    }
    $result = [pscustomobject]@{ Handled = $false; ReconnectRoots = @() }
    # A server-only request must not be blocked by a disconnected Desktop.
    if ($ServerOnly -or $roots.Count -eq 0) { return $result }

    $runtime = Get-ReusableRuntimeState -PackageInfo $PackageInfo -PortNumber $PortNumber -SuppressFailureLog
    $connected = $null -ne $runtime -and
        (Test-DesktopWebSocketConnection -DesktopExecutable $PackageInfo.DesktopExecutable -PortNumber $PortNumber)
    $recordedOwner = $connected -and $runtime.desktopConnectionVerified -eq $true -and
        @($roots | Where-Object { $_.ProcessId -notin $runtime.desktopProcessIds }).Count -eq 0
    if ($recordedOwner) {
        Write-LauncherLog "Desktop is already running; launch skipped. pid=$($roots.ProcessId -join ',') sharedConnected=True. No process was stopped."
        Write-LauncherProgress -Phase 'skipped' -Summary 'すでに起動・共有接続済みのため、起動をスキップしました。' -ServerStatus '起動済み（スキップ）' -DesktopStatus '共有接続済み（スキップ）'
        $result.Handled = $true
        return $result
    }

    $expected = "ws://127.0.0.1:$PortNumber"
    $endpoints = @{}
    if (-not $connected) {
        $null = Read-CodexDesktopStartupProgress -DesktopRoots $roots -Offsets @{} -PackageInfo $PackageInfo `
            -ExpectedWebSocketUrl $expected -SharedEndpointByDesktop $endpoints
    }
    $waiting = @($roots | Where-Object {
        $started = [DateTimeOffset]$_.CreationDate
        $actor = "$($_.ProcessId)|$($started.UtcDateTime.Ticks)"
        $endpoints.ContainsKey($actor) -and $endpoints[$actor].Endpoint -eq $expected
    })
    if ($connected -or $waiting.Count -eq $roots.Count) {
        Write-LauncherLog "Existing Desktop targets the shared endpoint; restoring its connection without relaunch. pid=$($roots.ProcessId -join ',') endpoint=$expected"
        $result.ReconnectRoots = $roots
        return $result
    }

    if ($RetryDesktop) {
        Write-LauncherProgress -Phase 'desktop-closing' -Summary 'Desktop を終了しています。' -DesktopStatus '正常終了待ち…'
        foreach ($root in $roots) {
            $live = Get-Process -Id $root.ProcessId -ErrorAction Stop
            if (-not $live.CloseMainWindow()) { throw 'Desktop が正常終了の要求を受け付けませんでした。Desktop を通常の操作で終了してから再試行してください。' }
        }
        $closeDeadline = [DateTimeOffset]::Now.AddSeconds(30)
        do {
            Assert-LauncherNotCancelled
            Start-Sleep -Milliseconds 250
            $roots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $PackageInfo.DesktopExecutable)
        } while ($roots.Count -gt 0 -and [DateTimeOffset]::Now -lt $closeDeadline)
        if ($roots.Count -gt 0) { throw 'Desktop はトレイ等に残っています。Desktop を通常の操作で完全に終了してから再試行してください。強制終了は行っていません。' }
        return $result
    }

    Write-LauncherLog "Desktop launch skipped: its shared endpoint is unconfirmed. pid=$($roots.ProcessId -join ','). No process was stopped."
    Write-LauncherProgress -Phase 'skipped' -Summary 'Desktop は起動済みです。' -Detail '接続先を確認できません。Desktop の再試行か、共有 AppServer のみ起動を選んでください。' -ServerStatus '共有接続は未確認' -DesktopStatus '起動済み（スキップ）'
    $result.Handled = $true
    return $result
}

function Start-DesktopOnRuntime {
    param(
        [Parameter(Mandatory)][object]$PackageInfo,
        [Parameter(Mandatory)][object]$RuntimeState,
        [Parameter(Mandatory)][int]$PortNumber,
        [switch]$DesktopBrowserAccessTrial,
        [object[]]$ExistingDesktopRoots = @()
    )

    if ($ExistingDesktopRoots.Count -gt 0) {
        $currentRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $PackageInfo.DesktopExecutable)
        foreach ($expectedRoot in $ExistingDesktopRoots) {
            $matched = @($currentRoots | Where-Object {
                $_.ProcessId -eq $expectedRoot.ProcessId -and
                ([DateTimeOffset]$_.CreationDate).UtcDateTime.Ticks -eq ([DateTimeOffset]$expectedRoot.CreationDate).UtcDateTime.Ticks
            })
            if ($matched.Count -ne 1) { throw 'The existing Desktop identity changed before reconnection. No Desktop was launched or stopped.' }
        }
        if ($currentRoots.Count -ne $ExistingDesktopRoots.Count) { throw 'The existing Desktop set changed before reconnection.' }
    }
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopExecutable' -Value $PackageInfo.DesktopExecutable
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopProcessIds' -Value @()
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopConnectionVerified' -Value $false
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessTrial' -Value $false
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessCompatibility' -Value $false
    Write-RuntimeState -State $RuntimeState

    if ($ExistingDesktopRoots.Count -gt 0) {
        $desktopRoots = $currentRoots
        Write-LauncherProgress -Phase 'desktop-connecting' -Summary 'Desktop の再接続を待っています。' -ServerStatus '起動済み' -DesktopStatus '共有接続待ち…'
    }
    else {
        Write-LauncherProgress -Phase 'syncing-projects' -Summary '共有サーバーは起動済みです。Desktop のプロジェクトを確認しています。' -ServerStatus '起動済み'
        Invoke-DesktopProjectSync -WebSocketUrl $RuntimeState.websocketUrl
        Assert-LauncherNotCancelled
        Set-UserWebSocketEnvironment -WebSocketUrl $RuntimeState.websocketUrl
        Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_APP_SERVER_USE_LOCAL_DAEMON -ErrorAction SilentlyContinue

        Write-LauncherProgress -Phase 'desktop-starting' -Summary 'Desktop を起動しています。' -ServerStatus '起動済み' -DesktopStatus '起動中…'
        # Explorer/package activation can race environment broadcasts at logon.
        # Start the installed package executable with an explicit inherited endpoint.
        $desktopStartInfo = New-CodexDesktopStartInfo -DesktopExecutable $PackageInfo.DesktopExecutable `
            -WebSocketUrl $RuntimeState.websocketUrl
        $startedDesktop = [Diagnostics.Process]::Start($desktopStartInfo)
        if ($null -eq $startedDesktop) { throw 'The installed Desktop executable did not start.' }
        Write-LauncherLog "Desktop executable started with explicit shared endpoint. pid=$($startedDesktop.Id) appId=$($PackageInfo.ApplicationUserModelId)"

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
    }

    Set-RuntimeStateValue `
        -State $RuntimeState `
        -Name 'desktopProcessIds' `
        -Value @($desktopRoots | ForEach-Object { [int]$_.ProcessId })
    Write-RuntimeState -State $RuntimeState
    Write-LauncherLog "Desktop root detected. pid=$($RuntimeState.desktopProcessIds -join ',')"

    Write-LauncherProgress -Phase 'desktop-connecting' -Summary 'Desktop の共有接続を確認しています。' -ServerStatus '起動済み' -DesktopStatus '共有接続待ち…'
    $connectionVerified = Wait-DesktopSharedConnection -PackageInfo $PackageInfo -PortNumber $PortNumber -OwnedServerProcessId ([int]$RuntimeState.serverProcessId) -TimeoutSeconds $DesktopConnectionStallSeconds

    if (-not $connectionVerified) {
        Show-LauncherMessage -Message "Codex started, but the shared app-server connection could not be verified.`n`nCodex remains open. See:`n$logPath" -Icon 16
        throw 'Desktop の共有接続を確認できませんでした。Desktop の認証画面と共有接続のログを確認してください。'
    }

    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopConnectionVerified' -Value $true
    Set-RuntimeStateValue -State $RuntimeState -Name 'mode' -Value 'desktop'
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessTrial' -Value ([bool]$DesktopBrowserAccessTrial)
    if ($ExistingDesktopRoots.Count -eq 0) {
        Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessCompatibility' `
            -Value ($desktopStartInfo.EnvironmentVariables.ContainsKey('CODEX_APP_SERVER_USE_LOCAL_DAEMON') -and
                $desktopStartInfo.EnvironmentVariables['CODEX_APP_SERVER_USE_LOCAL_DAEMON'] -eq '1')
    }
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
