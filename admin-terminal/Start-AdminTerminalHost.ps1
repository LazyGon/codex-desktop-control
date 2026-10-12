param([string]$Root='C:\ProgramData\CodexAdminTerminal')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Host must be launched by its explicitly registered elevated task.'}
$config=Get-Content -LiteralPath (Join-Path $Root 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if($identity.User.Value -ne $config.userSid){throw 'Host user differs from installation authorization.'}
if((Get-FileHash -LiteralPath $config.nodePath -Algorithm SHA256).Hash -ne $config.nodeSha256){throw 'Configured Node runtime hash changed; reinstall explicitly, do not execute.'}
$mutex=[Threading.Mutex]::new($false,'Local\CodexAdminTerminal-'+$config.userSid)
try {$owns=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owns=$true}
if(-not $owns){exit 0}
$inbox=Join-Path $Root 'inbox';$results=Join-Path $Root 'results';$hostState=Join-Path $Root 'current.json'
function Save-Json([string]$Path,$Value){$tmp="$Path.$PID.tmp";$Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $tmp -Encoding UTF8;Move-Item -LiteralPath $tmp -Destination $Path -Force}
function Now {[DateTimeOffset]::Now.ToString('o')}
function Quote-Argument([string]$Value) {
    if($Value -notmatch '[\s"]' -and $Value.Length){return $Value}
    return '"'+([regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1'))+'"'
}
$state=[ordered]@{schemaVersion=1;phase='ready';pid=$PID;processStartTime=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o');userSid=$identity.User.Value;elevated=$true;startedAt=Now;transport='Local ACL-protected filesystem queue; no network listener';activeOperationId=$null}
Save-Json $hostState $state
$watcher=[IO.FileSystemWatcher]::new($inbox,'*.json');$watcher.NotifyFilter=[IO.NotifyFilters]'FileName,LastWrite'
$eventPrefix='CodexAdminHost.'+$PID+'.';$eventIds=@()
foreach($name in 'Created','Changed','Renamed','Error'){
    $eventIds+=($eventPrefix+$name)
    Register-ObjectEvent -InputObject $watcher -EventName $name -SourceIdentifier ($eventPrefix+$name) | Out-Null
}
$watcher.EnableRaisingEvents=$true
try {
    foreach($old in (Get-ChildItem -LiteralPath $results -Filter '*.json' -File)){
        $prior=Get-Content -LiteralPath $old.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
        if($prior.phase -in 'accepted','dispatching','running'){$prior.phase='unknown-after-host-restart-do-not-replay';$prior | Add-Member -NotePropertyName recoveryNote -NotePropertyValue 'Host restarted before a final receipt. Inspect actual state; never automatically replay.' -Force;Save-Json $old.FullName $prior}
    }
    while($true){
        if(Test-Path -LiteralPath (Join-Path $Root 'stop-request.json')){
            $state.phase='stopped-by-request';Save-Json $hostState $state;break
        }
        $requests=@(Get-ChildItem -LiteralPath $inbox -Filter '*.json' -File | Sort-Object CreationTimeUtc,Name)
        foreach($file in $requests){
            if(Test-Path -LiteralPath (Join-Path $Root 'stop-request.json')){break}
            if($file.BaseName -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'){continue}
            $receiptPath=Join-Path $results ($file.BaseName+'.json')
            if(Test-Path -LiteralPath $receiptPath){continue}
            $operation=[ordered]@{operationId=$file.BaseName;phase='accepted';acceptedAt=Now;hostPid=$PID;hostStartTime=$state.processStartTime;logDirectory=(Join-Path $results $file.BaseName)}
            Save-Json $receiptPath $operation
            $sourceLock=$null;$child=$null
            try {
                if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Request reparse points are not accepted.'}
                $request=Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
                if($request.operationId -ne $file.BaseName){throw 'Request identity mismatch.'}
                New-Item -ItemType Directory -Path $operation.logDirectory | Out-Null
                $protectedRequest=Join-Path $operation.logDirectory 'request.json'
                Save-Json $protectedRequest $request
                $guardInfo=New-Object Diagnostics.ProcessStartInfo
                $guardInfo.FileName=$config.nodePath;$guardInfo.UseShellExecute=$false;$guardInfo.CreateNoWindow=$true;$guardInfo.RedirectStandardOutput=$true;$guardInfo.RedirectStandardError=$true
                $guardInfo.Arguments=(@((Join-Path $Root 'guard.mjs'),$protectedRequest,(Join-Path $Root 'config.json')) | ForEach-Object {Quote-Argument $_}) -join ' '
                $guard=[Diagnostics.Process]::Start($guardInfo);$out=$guard.StandardOutput.ReadToEndAsync();$err=$guard.StandardError.ReadToEndAsync();$guard.WaitForExit()
                try {
                    if($guard.ExitCode -ne 0){throw ('Task permission/ownership guard refused: '+$err.GetAwaiter().GetResult())}
                    $operation.task=$out.GetAwaiter().GetResult() | ConvertFrom-Json
                } finally {$guard.Dispose()}
                $script=[IO.Path]::GetFullPath($request.scriptPath)
                if((Get-Item -LiteralPath $script).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Script reparse point is not accepted.'}
                $sourceLock=[IO.File]::Open($script,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
                $sha=[Security.Cryptography.SHA256]::Create();try {$actual=([BitConverter]::ToString($sha.ComputeHash($sourceLock))).Replace('-','')} finally {$sha.Dispose()}
                if($actual -ne $request.scriptSha256){throw 'Source hash changed; execution refused.'}
                $operation.scriptPath=$script;$operation.scriptSha256=$actual;$operation.purpose=$request.purpose
                $operation.phase='dispatching';Save-Json $receiptPath $operation
                $state.phase='executing';$state.activeOperationId=$request.operationId;Save-Json $hostState $state
                $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$script)+@($request.arguments)
                $line=($arguments | ForEach-Object {Quote-Argument ([string]$_)}) -join ' '
                $child=Start-Process -FilePath $config.powerShell -ArgumentList $line -WorkingDirectory $request.workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $operation.logDirectory 'stdout.log') -RedirectStandardError (Join-Path $operation.logDirectory 'stderr.log')
                $null=$child.Handle;$operation.pid=$child.Id;$operation.processStartTime=$child.StartTime.ToUniversalTime().ToString('o');$operation.phase='running';Save-Json $receiptPath $operation
                $child.WaitForExit();$operation.exitCode=$child.ExitCode;$operation.finishedAt=Now
                $operation.phase=if($null -eq $child.ExitCode){'unknown-do-not-replay'}else{'completed'}
                Save-Json $receiptPath $operation
            } catch {
                $operation.failure=$_.Exception.Message;$operation.finishedAt=Now
                $operation.phase=if($operation.phase -in 'dispatching','running'){'unknown-do-not-replay'}else{'rejected-not-executed'}
                Save-Json $receiptPath $operation
            } finally {
                if($sourceLock){$sourceLock.Dispose()};if($child){$child.Dispose()}
                $state.phase='ready';$state.activeOperationId=$null;Save-Json $hostState $state
            }
        }
        if(Test-Path -LiteralPath (Join-Path $Root 'stop-request.json')){continue}
        # Registered events are queued before scanning, including a change between scan and wait.
        # Overflow also wakes a full rescan; no time-based polling or automatic command replay.
        $null=Wait-Event
        Get-Event | Where-Object {$_.SourceIdentifier -in $eventIds} | Remove-Event
    }
} finally {
    foreach($id in $eventIds){Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue}
    $watcher.Dispose();if($owns){$mutex.ReleaseMutex()};$mutex.Dispose()
}
