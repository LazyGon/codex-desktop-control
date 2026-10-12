param(
    [Parameter(Mandatory)][string]$ThreadId,
    [Parameter(Mandatory)][string]$ScriptPath,
    [Parameter(Mandatory)][string]$Workspace,
    [Parameter(Mandatory)][string]$Purpose,
    [Parameter(Mandatory)][Guid]$OperationId,
    [string[]]$ScriptArguments=@(),
    [string]$Root='C:\ProgramData\CodexAdminTerminal',
    [switch]$Wait
)
$ErrorActionPreference='Stop'
$state=Get-Content -LiteralPath (Join-Path $Root 'current.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if($state.userSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or -not $state.elevated){throw 'Admin terminal identity is not verified.'}
$process=Get-Process -Id $state.pid -ErrorAction Stop
if($process.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]$state.processStartTime).UtcDateTime.Ticks){throw 'Admin terminal PID has been reused.'}
$id=$OperationId.ToString();$receipt=Join-Path $Root ('results\'+$id+'.json');$inbox=Join-Path $Root ('inbox\'+$id+'.json')
if((Test-Path -LiteralPath $receipt) -or (Test-Path -LiteralPath $inbox)){throw 'Operation ID already exists; read its receipt, never replay.'}
$script=(Resolve-Path -LiteralPath $ScriptPath).Path;$work=(Resolve-Path -LiteralPath $Workspace).Path
$request=[ordered]@{operationId=$id;threadId=$ThreadId;workspace=$work;purpose=$Purpose;scriptPath=$script;scriptSha256=(Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash;arguments=@($ScriptArguments);submittedAt=[DateTimeOffset]::Now.ToString('o')}
$watcher=[IO.FileSystemWatcher]::new((Join-Path $Root 'results'),($id+'.json'));$watcher.NotifyFilter=[IO.NotifyFilters]'FileName,LastWrite'
$eventPrefix='CodexAdminClient.'+$PID+'.';$eventIds=@()
foreach($name in 'Created','Changed','Renamed','Error'){
    $eventIds+=($eventPrefix+$name)
    Register-ObjectEvent -InputObject $watcher -EventName $name -SourceIdentifier ($eventPrefix+$name) | Out-Null
}
$eventIds+=($eventPrefix+'HostExited')
. (Join-Path $PSScriptRoot 'ProcessExitObserver.ps1')
$exitObserver=[CodexAdmin.ProcessExitObserver]::new([int]$state.pid)
Register-ObjectEvent -InputObject $exitObserver -EventName Exited -SourceIdentifier ($eventPrefix+'HostExited') | Out-Null
$exitObserver.Start();$watcher.EnableRaisingEvents=$true
try {
    $tmp=$inbox+'.'+$PID+'.tmp';$stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($request | ConvertTo-Json -Depth 6));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    [IO.File]::Move($tmp,$inbox)
    if(-not $Wait){[ordered]@{operationId=$id;phase='submitted-not-yet-executed';receiptPath=$receipt} | ConvertTo-Json;exit 0}
    while($true){
        if(Test-Path -LiteralPath $receipt){
            $result=Get-Content -LiteralPath $receipt -Encoding UTF8 -Raw | ConvertFrom-Json
            if($result.phase -notin 'accepted','dispatching','running'){
                $result | ConvertTo-Json -Depth 8
                if($result.phase -ne 'completed' -or $null -eq $result.exitCode){exit 1};exit ([int]$result.exitCode)
            }
        }
        if($exitObserver.HasExited){throw 'Admin host exited without a final receipt. Outcome is unknown; inspect and do not replay.'}
        # Both filesystem changes and host death are registered before submission, so neither is lost.
        $null=Wait-Event
        Get-Event | Where-Object {$_.SourceIdentifier -in $eventIds} | Remove-Event
    }
} finally {
    foreach($eventId in $eventIds){Unregister-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue}
    $watcher.Dispose();$exitObserver.Dispose();$process.Dispose()
}
