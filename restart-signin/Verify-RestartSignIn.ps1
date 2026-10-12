$ErrorActionPreference='Stop'
$root='C:\ProgramData\CodexRestartSignIn'
$config=Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($config.userSid -ne $sid){throw 'Wrong owning Windows SID.'}
$checked=@()
foreach($name in @('config.json','current.json')+@($config.files.name)+@('operations','restore-check.json')){
    $file=Join-Path $root $name;$acl=Get-Acl -LiteralPath $file
    if($acl.Owner -notmatch '(Administrators|S-1-5-32-544)$'){throw 'Protected owner mismatch.'}
    foreach($ace in $acl.Access){
        $aceSid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($aceSid -notin 'S-1-5-18','S-1-5-32-544' -and $ace.AccessControlType -eq 'Allow' -and ([int64]$ace.FileSystemRights -band [int64][Security.AccessControl.FileSystemRights]'Write,Delete,ChangePermissions,TakeOwnership')){throw 'Unprivileged write ACL found.'}
    }
    $checked+=@{name=$name;ownerAdmin=$true;noUnprivilegedWrite=$true}
}
foreach($pin in $config.files){if((Get-FileHash -LiteralPath (Join-Path $root $pin.name) -Algorithm SHA256).Hash -ne $pin.sha256){throw 'Installed source changed.'}}
foreach($pin in $config.dependencies){if((Get-FileHash -LiteralPath $pin.file -Algorithm SHA256).Hash -ne $pin.sha256){throw 'Dependency pin changed.'}}
$task=Get-ScheduledTask -TaskName $config.restoreTask
$taskSid=([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
if($taskSid -ne $sid -or [string]$task.Principal.RunLevel -ne 'Highest' -or [string]$task.Principal.LogonType -ne 'Interactive' -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or $task.Actions[0].Arguments -ne $config.restoreArguments -or $task.Triggers.Count -ne 1 -or $task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or -not $task.Settings.Enabled){throw 'Fixed task mismatch.'}
$service=New-Object -ComObject Schedule.Service;$service.Connect();$registered=$service.GetFolder('\').GetTask($config.restoreTask)
$dacl=$registered.GetSecurityDescriptor(4)
$sd=[Security.AccessControl.RawSecurityDescriptor]::new($dacl)
foreach($ace in $sd.DiscretionaryAcl){if($ace.SecurityIdentifier.Value -notin 'S-1-5-18','S-1-5-32-544' -and ($ace.AccessMask -band (0x40000000 -bor 0x10000000 -bor 0x00010000 -bor 0x00040000 -bor 0x00080000))){throw 'Unprivileged task mutation ACL found.'}}
$check=Get-Content -LiteralPath (Join-Path $root 'restore-check.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$info=Get-ScheduledTaskInfo -TaskName $config.restoreTask
if($check.phase -ne 'idle-no-change' -or -not $check.elevated -or $check.userSid -ne $sid -or $check.settingChanged -or $info.LastTaskResult -ne 0){throw 'Scheduled no-op actual admin execution unverified.'}
$user=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO\'+$sid)
$win=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon')
try {
    if($user.GetValue('OptOut') -ne 1 -or $win.GetValue('AutoAdminLogon',$null) -eq '1' -or $win.GetValueNames() -contains 'DefaultPassword'){throw 'Ordinary no-autologon baseline changed.'}
}finally{$user.Dispose();$win.Dispose()}
$lease=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($lease.phase -ne 'idle' -or @(Get-ChildItem -LiteralPath (Join-Path $root 'operations') -File).Count -ne 0){throw 'A sign-in/restart operation unexpectedly exists.'}
$report=[ordered]@{observedAt=[DateTimeOffset]::Now.ToString('o');phase='installed-and-non-reboot-verified';protectedAclAndHashes=$true;dependencyPins=$true;taskDaclProtected=$true;fixedCurrentUserLogonRestorationTask=$true;actualSchedulerElevatedNoop=$true;noopPid=$check.pid;taskLastResult=$info.LastTaskResult;ordinaryUserOptOut=1;permanentAutoAdminLogonEnabled=$false;leasePhase=$lease.phase;restartIssued=$false;arsoBootTest='not authorized/not yet performed';noPasswordReadOrStorage=$true;noExtraUac=$true;files=$checked}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'state\windows-autologon-20261011\restart-signin-verification.json') -Encoding UTF8
[pscustomobject]$report | Select-Object phase,protectedAclAndHashes,actualSchedulerElevatedNoop,ordinaryUserOptOut,permanentAutoAdminLogonEnabled,leasePhase,restartIssued,arsoBootTest | ConvertTo-Json
