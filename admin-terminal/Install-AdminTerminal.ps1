param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Encoding UTF8 -Raw | ConvertFrom-Json
if(Test-Path -LiteralPath $job.receiptPath){throw 'Bootstrap receipt already exists; no replay.'}
$receipt=[ordered]@{requestId=$job.requestId;phase='starting';startedAt=[DateTimeOffset]::Now.ToString('o');workerPid=$PID;workerStartTime=(Get-Process -Id $PID).StartTime;root=$job.installRoot}
function Save-Receipt {$tmp="$($job.receiptPath).$PID.tmp";$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8;Move-Item -LiteralPath $tmp -Destination $job.receiptPath -Force}
Save-Receipt
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$receipt.elevated=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if(-not $receipt.elevated -or $identity.User.Value -ne $job.userSid){throw 'Bootstrap needs this user''s one normal UAC authorization.'}
    $root=[IO.Path]::GetFullPath($job.installRoot)
    if($root -ne 'C:\ProgramData\CodexAdminTerminal' -or (Test-Path -LiteralPath $root)){throw 'Unexpected/preexisting protected install target; inspect, do not overwrite.'}
    foreach($asset in $job.files){if((Get-FileHash -LiteralPath $asset.source -Algorithm SHA256).Hash -ne $asset.sha256){throw 'Bootstrap source hash changed.'}}
    if((Get-FileHash -LiteralPath $job.nodePath -Algorithm SHA256).Hash -ne $job.nodeSha256){throw 'Node runtime hash changed.'}
    $admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$owner=[Security.Principal.SecurityIdentifier]::new($job.userSid)
    function Protect-Directory([string]$Path,[bool]$Writable) {
        $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($admin)
        foreach($sid in @($admin,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
        $rights=if($Writable){'Modify'}else{'ReadAndExecute'}
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner,$rights,'ContainerInherit,ObjectInherit','None','Allow'))
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    New-Item -ItemType Directory -Path $root | Out-Null;Protect-Directory $root $false
    foreach($name in 'inbox','results'){New-Item -ItemType Directory -Path (Join-Path $root $name) | Out-Null;Protect-Directory (Join-Path $root $name) ($name -eq 'inbox')}
    foreach($asset in $job.files){Copy-Item -LiteralPath $asset.source -Destination (Join-Path $root $asset.name) -ErrorAction Stop;if((Get-FileHash -LiteralPath (Join-Path $root $asset.name) -Algorithm SHA256).Hash -ne $asset.sha256){throw 'Installed asset hash mismatch.'}}
    Copy-Item -LiteralPath $job.nodePath -Destination (Join-Path $root 'node.exe')
    if((Get-FileHash -LiteralPath (Join-Path $root 'node.exe') -Algorithm SHA256).Hash -ne $job.nodeSha256){throw 'Protected Node runtime copy hash mismatch.'}
    $config=[ordered]@{schemaVersion=1;userSid=$job.userSid;userName=$identity.Name;controlRoot=$job.controlRoot;nodePath=(Join-Path $root 'node.exe');nodeSha256=$job.nodeSha256;powerShell=$job.powerShell;taskName='Codex Admin Terminal';scope='Local user-approved administration for permitted tasks. No network listener, UAC disabling, password storage or task permission changes.'}
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'config.json') -Encoding UTF8
    $action=New-ScheduledTaskAction -Execute $job.powerShell -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $root 'Start-AdminTerminalHost.ps1')+'"') -WorkingDirectory $root
    $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    # Scheduler's documented minimum recovery interval and schema maximum recovery count.
    # Recovery restarts only the host; unfinished commands become UNKNOWN and are never replayed.
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartInterval ([TimeSpan]::FromMinutes(1)) -RestartCount 255
    if(Get-ScheduledTask -TaskName $config.taskName -ErrorAction SilentlyContinue){throw 'Admin task already exists; do not replace.'}
    Register-ScheduledTask -TaskName $config.taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'User-authorized persistent local admin PowerShell host, startup after each user logon; protected fixed action, local inbox only. No network endpoint.' | Out-Null
    $service=New-Object -ComObject Schedule.Service;$service.Connect();$task=$service.GetFolder('\').GetTask($config.taskName)
    $task.SetSecurityDescriptor(('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;'+$job.userSid+')'),0)
    $receipt.phase='registered';$receipt.taskName=$config.taskName;$receipt.logonType='Interactive';$receipt.runLevel='Highest';$receipt.commandSurface='Pinned local PowerShell script + exact task/operation identity; guarded against task sandbox bypass';Save-Receipt
    Start-ScheduledTask -TaskName $config.taskName
    $receipt.phase='completed';$receipt.finishedAt=[DateTimeOffset]::Now.ToString('o');Save-Receipt
} catch {$receipt.phase='failed-no-replay';$receipt.failure=@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message};$receipt.finishedAt=[DateTimeOffset]::Now.ToString('o');Save-Receipt;exit 1}
