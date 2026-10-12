param([Parameter(Mandatory)][string]$ManifestPath)
. (Join-Path $PSScriptRoot 'Common.ps1')
$m=Read-RestartJson $ManifestPath
$root='C:\ProgramData\CodexRestartSignIn'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -ne $m.userSid -or -not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Use the current user approved common administrator host.'}
if((Test-Path -LiteralPath $root) -or (Get-ScheduledTask -TaskName 'Codex Restart Sign-In Restore' -ErrorAction SilentlyContinue)){throw 'Existing install; diagnose instead of replacing.'}
foreach($f in $m.files){if((Get-RestartHash $f.source) -ne $f.sha256 -or [IO.Path]::GetFileName($f.name) -ne $f.name){throw 'Reviewed source mismatch.'}}
foreach($d in $m.dependencies){if((Get-RestartHash $d.file) -ne $d.sha256){throw 'Dependency changed.'}}
$admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$user=[Security.Principal.SecurityIdentifier]::new($m.userSid)
New-Item -ItemType Directory -Path $root | Out-Null
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($admin)
foreach($s in @($admin,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));Set-Acl -LiteralPath $root -AclObject $acl
New-Item -ItemType Directory -Path (Join-Path $root 'operations') | Out-Null
foreach($f in $m.files){
    $dest=Join-Path $root $f.name
    Copy-Item -LiteralPath $f.source -Destination $dest
    $fileAcl=Get-Acl -LiteralPath $dest;$fileAcl.SetOwner($admin);Set-Acl -LiteralPath $dest -AclObject $fileAcl
}
$arguments='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $root 'Restore-RestartSignIn.ps1')+'"'
$config=@{schemaVersion=1;userSid=$m.userSid;controlRoot=$m.controlRoot;nodePath=$m.nodePath;files=@($m.files|ForEach-Object{@{name=$_.name;sha256=$_.sha256}});dependencies=$m.dependencies;restoreTask='Codex Restart Sign-In Restore';restoreArguments=$arguments}
Save-RestartJson (Join-Path $root 'config.json') $config
Save-RestartJson (Join-Path $root 'current.json') @{phase='idle';userSid=$m.userSid;installedAt=[DateTimeOffset]::Now.ToString('o')}
$action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments -WorkingDirectory $root
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $config.restoreTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Only restores this account previous ARSO opt-out after an explicitly agent-requested reboot. Never logs in, restarts Windows, reads credentials or accepts arbitrary commands.' | Out-Null
$service=New-Object -ComObject Schedule.Service;$service.Connect()
$task=$service.GetFolder('\').GetTask($config.restoreTask)
$task.SetSecurityDescriptor(('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;'+$m.userSid+')'),0)
$null=Assert-RestartInstall $root
Restore-RestartSignIn $root
& (Join-Path $root 'Invoke-RestartSignIn.ps1') -Mode Inspect
