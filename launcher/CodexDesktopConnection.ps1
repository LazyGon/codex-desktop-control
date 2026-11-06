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
    while ($true) {
        Assert-LauncherNotCancelled
        $roots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $PackageInfo.DesktopExecutable)
        if ($roots.Count -gt 0) {
            $stage = Read-CodexDesktopStartupProgress -DesktopRoots $roots -Offsets $progressOffsets -PackageInfo $PackageInfo
            if ($stage -gt $lastStage) {
                $lastStage = $stage
                $lastProgressSeconds = $watch.Elapsed.TotalSeconds
                Write-LauncherLog "Desktop forward startup progress observed. stage=$lastStage totalSeconds=$([int]$watch.Elapsed.TotalSeconds)"
                Write-LauncherProgress -Phase 'desktop-connecting' -Summary 'Desktop の初期化が進んでいます。進捗が続く間は接続を待ちます。' -Detail "確認済み段階: $lastStage。進捗停止の確認時間: $TimeoutSeconds 秒。" -ServerStatus '起動済み' -DesktopStatus '初期化進行中…'
            }
        }
        $ownedServer = Get-Process -Id $OwnedServerProcessId -ErrorAction SilentlyContinue
        $decision = Get-CodexDesktopConnectionDecision `
            -Connected (Test-DesktopWebSocketConnection -DesktopExecutable $PackageInfo.DesktopExecutable -PortNumber $PortNumber) `
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

function Start-DesktopOnRuntime {
    param(
        [Parameter(Mandatory)][object]$PackageInfo,
        [Parameter(Mandatory)][object]$RuntimeState,
        [Parameter(Mandatory)][int]$PortNumber,
        [switch]$DesktopBrowserAccessTrial
    )

    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopExecutable' -Value $PackageInfo.DesktopExecutable
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopProcessIds' -Value @()
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopConnectionVerified' -Value $false
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessTrial' -Value $false
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessCompatibility' -Value $false
    Write-RuntimeState -State $RuntimeState

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
        -WebSocketUrl $RuntimeState.websocketUrl -PackageVersion $PackageInfo.Version `
        -DesktopBrowserAccessTrial:$DesktopBrowserAccessTrial
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
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessTrial' -Value ([bool]$DesktopBrowserAccessTrial)
    Set-RuntimeStateValue -State $RuntimeState -Name 'desktopBrowserAccessCompatibility' `
        -Value ($desktopStartInfo.EnvironmentVariables['CODEX_APP_SERVER_USE_LOCAL_DAEMON'] -eq '1')
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
