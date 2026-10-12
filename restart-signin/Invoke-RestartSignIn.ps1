param([ValidateSet('Inspect','Execute')][string]$Mode='Inspect',[string]$AuthorizationPath,[string]$PostbootJobPath)
. (Join-Path $PSScriptRoot 'Common.ps1')
$root='C:\ProgramData\CodexRestartSignIn'
$config=Assert-RestartInstall $root
Assert-RestartDependencies $config
$facts=Assert-ArsoCompatibility $config.userSid
Add-Type -Path (Join-Path $root 'NativeRestart.cs')
if(-not [CodexRestartSignIn.NativeRestart]::ExportAvailable()){throw 'Required Windows export unavailable.'}
if($Mode -eq 'Inspect'){
    [pscustomobject]@{phase='installed-dry-run';apiExportAvailable=$true;restartFlags=[CodexRestartSignIn.NativeRestart]::Flags;forceClose=$false;restartOtherApps=$false;permanentAutoLogon=$facts.permanentAutoLogon;currentUserOptOut=$facts.optOut.value;leasePhase=(Read-RestartJson (Join-Path $root 'current.json')).phase;restarted=$false;changedSettings=$false} | ConvertTo-Json
    return
}
if(-not $AuthorizationPath -or -not $PostbootJobPath){throw 'Explicit fresh restart authorization and continuation are mandatory.'}
$auth=Read-RestartJson $AuthorizationPath;$post=Read-RestartJson $PostbootJobPath
$id=([Guid]$auth.operationId).ToString()
if($auth.phase -ne 'prepared' -or $auth.restartAuthorized -ne $true -or $auth.restartSignInAuthorized -ne $true -or -not $auth.authorizationReference){throw 'No scoped restart authorization.'}
if($auth.userSid -ne $config.userSid -or $auth.operationId -ne $id -or $post.operationId -ne $id -or $post.threadId -ne $auth.threadId -or $post.phase -ne 'prepared' -or $post.restoreRoot -ne $root){throw 'Restart/continuation identity mismatch.'}
$admin=Read-RestartJson 'C:\ProgramData\CodexAdminTerminal\current.json'
if($admin.phase -ne 'executing' -or $admin.activeOperationId -ne $id){throw 'Execute only through the owning guarded common-admin operation with the same fresh ID.'}
$admitted=Read-RestartJson ('C:\ProgramData\CodexAdminTerminal\results\'+$id+'.json')
if($admitted.phase -ne 'running' -or $admitted.pid -ne $PID -or $admitted.task.threadId -ne $auth.threadId -or $admitted.task.workspace -ne $auth.workspace -or $admitted.task.approvalPolicy -ne 'never' -or $admitted.task.sandbox -ne 'dangerFullAccess'){throw 'Owning task/admin worker admission mismatch; do not borrow another task.'}
foreach($pin in $auth.sourcePins){if((Get-RestartHash $pin.file) -ne $pin.sha256){throw 'Reviewed restart source/evidence changed.'}}
$task=Get-ScheduledTask -TaskName $post.schedulerTask
$taskSid=([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
$expectedArgs='"'+(Join-Path $config.controlRoot 'restart-signin\session.mjs')+'" logon "'+$PostbootJobPath+'"'
if(-not $task.Settings.Enabled -or $taskSid -ne $config.userSid -or [string]$task.Principal.RunLevel -ne 'Limited' -or [string]$task.Principal.LogonType -ne 'Interactive' -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $config.nodePath -or $task.Actions[0].Arguments -ne $expectedArgs -or $task.Triggers.Count -ne 1 -or $task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger'){throw 'Same-task logon receiver not registered exactly.'}
$restore=Get-ScheduledTask -TaskName $config.restoreTask
$restoreSid=([Security.Principal.NTAccount]::new($restore.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
if(-not $restore.Settings.Enabled -or $restoreSid -ne $config.userSid -or [string]$restore.Principal.RunLevel -ne 'Highest' -or [string]$restore.Principal.LogonType -ne 'Interactive' -or $restore.Actions.Count -ne 1 -or $restore.Actions[0].Execute -ne 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or $restore.Actions[0].Arguments -ne $config.restoreArguments -or $restore.Triggers.Count -ne 1 -or $restore.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or -not $restore.Triggers[0].Enabled){throw 'Protected restoration task unavailable.'}
$startup=Get-ScheduledTask -TaskName 'Codex Discord Remote'
$bridge=Read-RestartJson (Join-Path $config.controlRoot 'discord-bridge\config\config.json')
if(-not $startup.Settings.Enabled -or -not $bridge.autoStartSharedDesktop){throw 'Existing canonical runtime startup unavailable.'}
if(Test-Path -LiteralPath (Join-Path $config.controlRoot 'launcher\state\package-update-drain.json')){throw 'Existing runtime drain requires separate review.'}
if((Read-RestartJson (Join-Path $root 'current.json')).phase -ne 'idle'){throw 'Another sign-in lease exists; never replace or replay it.'}
# The administrator host admitted this specific hashed operation while its owner was active.
# Wait for that owner to finish, without keeping a Codex turn busy or restarting any other task.
& $config.nodePath (Join-Path $config.controlRoot 'restart-signin\session.mjs') wait-idle $AuthorizationPath
if($LASTEXITCODE -ne 0){throw 'Idle/ownership verification failed.'}
$authLatest=Read-RestartJson $AuthorizationPath
if($authLatest.phase -ne 'prepared' -or $authLatest.operationId -ne $id -or $authLatest.threadId -ne $auth.threadId -or $authLatest.restartAuthorized -ne $true -or $authLatest.restartSignInAuthorized -ne $true){throw 'Authorization was withdrawn while waiting.'}
$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
if($boot.Ticks -ne ([DateTimeOffset]$auth.previousBoot).UtcDateTime.Ticks){throw 'Boot already changed; no repeat.'}
if(@(Get-Process -Name msiexec,pnputil,7z,consent -ErrorAction SilentlyContinue).Count -or (New-Object -ComObject Microsoft.Update.Installer).IsBusy){throw 'Installers have not settled.'}
$facts=Assert-ArsoCompatibility $config.userSid
$opFile=Join-Path $root ('operations\'+$id+'.json')
$reserve=[IO.File]::Open($opFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$reserve.Dispose()
$op=[ordered]@{operationId=$id;phase='prepared';threadId=$auth.threadId;userSid=$config.userSid;previousBoot=$boot.ToString('o');originalOptOut=$facts.optOut;authorizationReference=$auth.authorizationReference;preparedAt=[DateTimeOffset]::Now.ToString('o');flags=8196;noForcedClose=$true;noPasswordHandling=$true}
Save-RestartJson $opFile $op
Save-RestartJson (Join-Path $root 'current.json') @{phase='active';operationId=$id;userSid=$config.userSid}
try {
    $post.phase='armed-for-next-boot';Save-RestartJson $PostbootJobPath $post
    $op.phase='optout-enabling';Save-RestartJson $opFile $op
    $key=[Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO\'+$config.userSid)
    try {$key.SetValue('OptOut',0,[Microsoft.Win32.RegistryValueKind]::DWord)} finally {$key.Dispose()}
    if((Get-SignInFacts $config.userSid).optOut.value -ne 0){throw 'Temporary sign-in opt-in not verified.'}
    $op.phase='optout-enabled';Save-RestartJson $opFile $op
    $op.phase='restart-dispatching';Save-RestartJson $opFile $op
    $result=[CodexRestartSignIn.NativeRestart]::RequestOneRestart()
    $op.apiReturn=$result
    if($result -ne 0){$op.phase='restart-not-accepted';Save-RestartJson $opFile $op;Restore-RestartSignIn $root -Cancel;throw 'Windows rejected restart; original setting restored.'}
    $op.phase='restart-request-accepted';$op.acceptedAt=[DateTimeOffset]::Now.ToString('o');Save-RestartJson $opFile $op
    # Acceptance is not actual reboot/sign-in success. The fixed logon restore and receiver verify those separately.
} catch {
    if($op.phase -notin 'restart-dispatching','restart-request-accepted') {Restore-RestartSignIn $root -Cancel}
    else {$op.phase='unknown-do-not-repeat';$op.failureType=$_.Exception.GetType().FullName;Save-RestartJson $opFile $op}
    throw
}
