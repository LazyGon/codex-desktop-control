$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$python=Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/pythonw.exe'
if(-not (Test-Path -LiteralPath $python)){throw 'Existing windowless Python runtime is missing.'}
foreach($session in 'Conversation','Haiku'){
    $name='Claude Sign-In '+$session
    if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw ('Task already exists; inspect before updating: '+$name)}
    $action=New-ScheduledTaskAction -Execute $python -Argument ('"'+(Join-Path $PSScriptRoot 'launch.py')+'" '+$session) -WorkingDirectory $PSScriptRoot
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $sid
    $trigger.Delay='PT30S'
    $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Minimized Claude at sign-in; skip existing session; one retry only after process exit.' | Out-Null
}
