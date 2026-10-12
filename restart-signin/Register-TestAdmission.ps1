param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$config=Get-Content -LiteralPath 'C:\ProgramData\CodexAdminTerminal\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if($job.phase -ne 'prepared' -or $job.requireStandardUac -or $job.workspace -ne $config.controlRoot -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $config.userSid){throw 'Exact prepared limited admission required.'}
if(Get-ScheduledTask -TaskName $job.schedulerTask -ErrorAction SilentlyContinue){throw 'Admission task exists; never recreate.'}
foreach($item in @(@{file=$job.adminScript;sha256=$job.adminExpectedScriptSha256},@{file=$job.workerScript;sha256=$job.workerExpectedSha256},@{file=$config.nodePath;sha256=$config.nodeSha256})){
    if((Get-FileHash -LiteralPath $item.file -Algorithm SHA256).Hash -ne $item.sha256){throw 'Admission execution source changed.'}
}
$controller=Join-Path $job.workspace 'control\one-shot-job.mjs'
if(-not $job.sourcePins){throw 'Pinned continuation sources are required for a new admission.'}
foreach($pin in $job.sourcePins){if((Get-FileHash -LiteralPath $pin.file -Algorithm SHA256).Hash -ne $pin.sha256){throw 'Pinned admission controller dependency changed.'}}
$arguments='"'+$controller+'" run "'+$JobPath+'"'
$action=New-ScheduledTaskAction -Execute $config.nodePath -Argument $arguments -WorkingDirectory $job.workspace
$principal=New-ScheduledTaskPrincipal -UserId $config.userSid -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $job.schedulerTask -Action $action -Principal $principal -Settings $settings -Description 'Manually started once; guarded common admin admission waits for exact owner idle. No other tasks or policies changed.' | Out-Null
$actual=Get-ScheduledTask -TaskName $job.schedulerTask
if($actual.Actions.Count -ne 1 -or $actual.Actions[0].Execute -ne $config.nodePath -or $actual.Actions[0].Arguments -ne $arguments -or [string]$actual.Principal.RunLevel -ne 'Limited' -or -not $actual.Settings.Enabled -or $actual.Triggers.Count){throw 'Admission registration mismatch.'}
[pscustomobject]@{phase='registered-not-started';taskName=$actual.TaskName;operationId=$job.operationId;restarted=$false}|ConvertTo-Json
