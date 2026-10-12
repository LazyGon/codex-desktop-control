param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$config=Get-Content -LiteralPath 'C:\ProgramData\CodexRestartSignIn\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if($job.phase -ne 'prepared' -or $job.restoreRoot -ne 'C:\ProgramData\CodexRestartSignIn' -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $config.userSid){throw 'Unprepared or wrong-user receiver.'}
if(Get-ScheduledTask -TaskName $job.schedulerTask -ErrorAction SilentlyContinue){throw 'Receiver exists; do not recreate.'}
foreach($pin in $job.sourcePins){if((Get-FileHash -LiteralPath $pin.file -Algorithm SHA256).Hash -ne $pin.sha256){throw 'Continuation source changed.'}}
$arguments='"'+(Join-Path $config.controlRoot 'restart-signin\session.mjs')+'" logon "'+$JobPath+'"'
$action=New-ScheduledTaskAction -Execute $config.nodePath -Argument $arguments -WorkingDirectory $job.workspace
$principal=New-ScheduledTaskPrincipal -UserId $config.userSid -LogonType Interactive -RunLevel Limited
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $config.userSid
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $job.schedulerTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'One exact-task continuation after a scoped reboot and original sign-in setting restoration; no alternate server or other-task resume.' | Out-Null
$task=Get-ScheduledTask -TaskName $job.schedulerTask
if($task.Actions[0].Execute -ne $config.nodePath -or $task.Actions[0].Arguments -ne $arguments -or [string]$task.Principal.RunLevel -ne 'Limited' -or -not $task.Settings.Enabled){throw 'Receiver actual registration mismatch.'}
[pscustomobject]@{phase='registered-not-reboot-armed';taskName=$task.TaskName;operationId=$job.operationId;threadId=$job.threadId;restarted=$false}|ConvertTo-Json
