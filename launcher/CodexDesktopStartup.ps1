function New-CodexDesktopStartInfo {
    param([Parameter(Mandatory)][string]$DesktopExecutable,[Parameter(Mandatory)][string]$WebSocketUrl)
    if($WebSocketUrl -notmatch '^ws://127\.0\.0\.1:\d+$'){throw 'Desktop startup requires the exact local shared endpoint.'}
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=[IO.Path]::GetFullPath($DesktopExecutable)
    $info.WorkingDirectory=Split-Path -Parent $info.FileName
    $info.UseShellExecute=$false
    # Desktop is the requested interactive app, not a background shell/helper.
    $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Normal
    $info.EnvironmentVariables['CODEX_APP_SERVER_WS_URL']=$WebSocketUrl
    $info.EnvironmentVariables.Remove('CODEX_APP_SERVER_FORCE_CLI')
    $info.EnvironmentVariables.Remove('CODEX_APP_SERVER_USE_LOCAL_DAEMON')
    $info
}

function Get-CodexDesktopConnectionDecision {
    param([bool]$Connected,[bool]$ServerAlive,[bool]$DesktopAlive,[bool]$Cancelled,[double]$ElapsedSeconds,[int]$TimeoutSeconds=180)
    if($TimeoutSeconds -lt 0){throw 'An optional Desktop connection timeout cannot be negative.'}
    if($Cancelled){throw [OperationCanceledException]::new('Desktop startup was cancelled.')}
    if(-not $ServerAlive){throw 'The owned shared AppServer exited during Desktop initialization.'}
    if(-not $DesktopAlive){throw 'Desktop exited before its shared connection was verified.'}
    if($Connected){return 'ready'}
    # ElapsedSeconds is time since the last positively observed startup stage,
    # not the total startup duration. Activity/repeated errors are not progress.
    if($TimeoutSeconds -gt 0 -and $ElapsedSeconds -ge $TimeoutSeconds){throw 'Desktop initialization made no verified forward progress during the configured inactivity interval.'}
    'pending'
}

function Get-CodexDesktopStartupLogStage {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Line)
    if($Line -match '\[StdioConnection\] stdio_transport_spawned '){return 10}
    if($Line -notmatch '\[AppServerConnection\]'){return 0}
    if($Line -notmatch '(?:^| )hostId=local(?: |$)'){return 0}
    if($Line -match 'initialize_handshake_result .*outcome=success .*transportKind=websocket'){return 40}
    if($Line -match 'app_server_connection\.state_changed .*initialized=true .*next=connected '){return 50}
    if($Line -match 'Transport start success '){return 30}
    if($Line -match 'Starting app-server connection '){return 20}
    return 0
}

function Read-CodexDesktopStartupProgress {
    param([Parameter(Mandatory)][object[]]$DesktopRoots,[Parameter(Mandatory)][hashtable]$Offsets,[Parameter(Mandatory)][object]$PackageInfo)
    $logRoots=@(
        (Join-Path $env:LOCALAPPDATA 'Codex\Logs'),
        (Join-Path $env:LOCALAPPDATA ('Packages\'+$PackageInfo.PackageFamilyName+'\LocalCache\Local\Codex\Logs'))
    )
    $maxStage=0
    foreach($root in $DesktopRoots){
        $started=[DateTimeOffset]$root.CreationDate
        $days=@($started.LocalDateTime.ToString('yyyy/MM/dd'),$started.UtcDateTime.ToString('yyyy/MM/dd'))|Select-Object -Unique
        foreach($base in $logRoots){foreach($day in $days){
            $directory=Join-Path $base $day
            if(-not (Test-Path -LiteralPath $directory -PathType Container)){continue}
            foreach($file in @(Get-ChildItem -LiteralPath $directory -Force -File -Filter ('codex-desktop-*-'+$root.ProcessId+'-t0-*.log'))){
                $offset=if($Offsets.ContainsKey($file.FullName)){[long]$Offsets[$file.FullName]}else{0L}
                if($file.Length -le $offset){continue}
                $stream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
                $reader=$null
                try {
                    [void]$stream.Seek($offset,[IO.SeekOrigin]::Begin)
                    $reader=[IO.StreamReader]::new($stream)
                    while(-not $reader.EndOfStream){
                        $line=$reader.ReadLine()
                        if($line -notmatch '^(\d{4}-\d{2}-\d{2}T\S+) '){continue}
                        $eventTime=[DateTimeOffset]::MinValue
                        if(-not [DateTimeOffset]::TryParse($Matches[1],[ref]$eventTime) -or $eventTime -lt $started){continue}
                        $stage=Get-CodexDesktopStartupLogStage -Line $line
                        if($stage -gt $maxStage){$maxStage=$stage}
                    }
                    $Offsets[$file.FullName]=$stream.Position
                }finally{if($reader){$reader.Dispose()}else{$stream.Dispose()}}
            }
        }}
    }
    $maxStage
}
