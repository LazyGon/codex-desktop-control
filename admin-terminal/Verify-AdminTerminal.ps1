param([Parameter(Mandatory)][string]$ReportPath,[Parameter(Mandatory)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$root='C:\ProgramData\CodexAdminTerminal'
$config=Get-Content -LiteralPath (Join-Path $root 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$state=Get-Content -LiteralPath (Join-Path $root 'current.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$task=Get-ScheduledTask -TaskName $config.taskName
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskSid=([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
if($sid -ne $config.userSid -or $sid -ne $state.userSid -or $sid -ne $taskSid){throw 'Actual installation/host/task user identity mismatch.'}
$process=Get-Process -Id $state.pid
if($process.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]$state.processStartTime).UtcDateTime.Ticks -or -not $state.elevated){throw 'Live admin host does not match canonical identity.'}
if([string]$task.Principal.RunLevel -ne 'Highest' -or [string]$task.Principal.LogonType -ne 'Interactive' -or [string]$task.State -ne 'Running'){throw 'Scheduled host principal/state mismatch.'}
if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $config.powerShell -or $task.Actions[0].Arguments -ne ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $root 'Start-AdminTerminalHost.ps1')+'"')){throw 'Scheduled task action changed.'}
if($task.Triggers.Count -ne 1 -or $task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or -not $task.Triggers[0].Enabled){throw 'User logon trigger missing.'}
$bootstrap=Get-Content -LiteralPath (Join-Path $EvidenceRoot 'admin-terminal-bootstrap-job.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$repair=Get-Content -LiteralPath (Join-Path $EvidenceRoot 'admin-terminal-client-repair-receipt.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$token=Get-Content -LiteralPath (Join-Path $EvidenceRoot 'admin-terminal-final-token-check-result.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if($repair.phase -ne 'completed' -or -not $token.elevated -or $token.userSid -ne $sid){throw 'Repair/actual installed-client administrator-token verification incomplete.'}
$hashes=@()
$guardUpdatePath=Join-Path $root 'guard-update.json'
$guardUpdate=if(Test-Path -LiteralPath $guardUpdatePath){Get-Content -LiteralPath $guardUpdatePath -Encoding UTF8 -Raw | ConvertFrom-Json}else{$null}
foreach($asset in $bootstrap.files){
    $latest=@($repair.operations | Where-Object file -eq $asset.name)
    $expected=if($latest.Count){$latest[0].actualSha256}else{$asset.sha256}
    if($asset.name -eq 'guard.mjs' -and $guardUpdate){
        if($guardUpdate.phase -ne 'installed' -or $guardUpdate.file -ne 'guard.mjs' -or $guardUpdate.beforeSha256 -ne $expected -or $guardUpdate.sourceSha256 -ne $guardUpdate.installedSha256 -or -not $guardUpdate.guardAclUnchanged -or -not $guardUpdate.asciiEnvelopeVerified -or -not $guardUpdate.shiftJisRoundTripVerified){throw 'Forward guard update evidence is inconsistent.'}
        $expected=$guardUpdate.installedSha256
    }
    $actual=(Get-FileHash -LiteralPath (Join-Path $root $asset.name) -Algorithm SHA256).Hash
    if($expected -ne $actual){throw ('Installed asset hash mismatch: '+$asset.name)}
    $hashes+=@{file=$asset.name;sha256=$actual;verified=$true}
}
$helper=Join-Path $root 'ProcessExitObserver.ps1'
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ne ($repair.operations | Where-Object file -eq 'ProcessExitObserver.ps1').actualSha256){throw 'OS exit observer hash mismatch.'}
if((Get-FileHash -LiteralPath $config.nodePath -Algorithm SHA256).Hash -ne $config.nodeSha256){throw 'Protected execution runtime hash mismatch.'}
$acls=@()
$protectedPaths=@($root,(Join-Path $root 'results'),(Join-Path $root 'config.json'),$config.nodePath,$helper)+@($bootstrap.files | ForEach-Object {Join-Path $root $_.name})
if($guardUpdate){$protectedPaths+=$guardUpdatePath}
foreach($item in $protectedPaths){
    $acl=Get-Acl -LiteralPath $item
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544'){throw 'Protected asset owner is not Administrators.'}
    foreach($rule in $acl.Access){
        $ruleSid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($rule.AccessControlType -eq 'Allow' -and $ruleSid -notin 'S-1-5-18','S-1-5-32-544'){
            if($ruleSid -ne $sid -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership)){throw 'Protected installation is writable by an unprivileged or unrelated principal.'}
        }
    }
    $acls+=@{path=$item;sddl=$acl.Sddl;verified=$true}
}
$listeners=@(Get-NetTCPConnection -State Listen | Where-Object OwningProcess -eq $state.pid).Count
if($listeners){throw 'Unexpected network listener on admin host.'}
$service=New-Object -ComObject Schedule.Service;$service.Connect()
$sddl=$service.GetFolder('\').GetTask($config.taskName).GetSecurityDescriptor(7)
$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($sddl)
foreach($ace in $descriptor.DiscretionaryAcl){
    if($ace.AceQualifier -eq 'AccessAllowed' -and $ace.SecurityIdentifier.Value -notin 'S-1-5-18','S-1-5-32-544'){
        if($ace.SecurityIdentifier.Value -ne $sid -or ($ace.AccessMask -band 0x000d0116)){throw 'Task has unexpected unprivileged write/owner/delete permission.'}
    }
}
$report=[ordered]@{observedAt=[DateTimeOffset]::Now.ToString('o');phase='verified-live';taskName=$config.taskName;userSid=$sid;hostPid=$state.pid;processStartTime=$state.processStartTime;hostPhase=$state.phase;actualAdminTokenVerified=$true;configuredLogonRecovery=$true;postRebootRecovery='Configured but not yet exercised; verify after authorized reboot and user sign-in';taskSecurityDescriptor=$sddl;protectedFileHashes=$hashes;protectedAcls=$acls;noHostTcpListener=($listeners -eq 0);noAdditionalUac=$true;tokenEvidence='admin-terminal-final-token-check-result.json';repairEvidence='admin-terminal-client-repair-receipt.json'}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
[pscustomobject]$report | Select-Object observedAt,phase,hostPid,actualAdminTokenVerified,configuredLogonRecovery,noHostTcpListener | ConvertTo-Json
