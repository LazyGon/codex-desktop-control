param(
    [ValidateSet('Install', 'Status', 'Stop', 'Enable')][string]$Mode = 'Status',
    [string]$NodePath = 'C:/Users/lazyg/Documents/Codex/2026-09-28/rvm-recovery/toolchain-cache/node-v24.21.0/node-v24.21.0-win-x64/node.exe'
)
$ErrorActionPreference = 'Stop'
$taskName = 'Codex System Error Recovery'
$description = 'Codex Desktop Control: same-thread terminal system-error recovery; current user Limited; no settings or authority overrides.'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $PSScriptRoot 'Invoke-SystemErrorRecovery.ps1'
$module = Join-Path $PSScriptRoot 'system-error-recovery.mjs'
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Recovery Node runtime is missing.' }
function Get-OwnedTask {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        $ownerSid = if ($existing.Principal.UserId -like 'S-1-*') { $existing.Principal.UserId } else {
            ([Security.Principal.NTAccount]$existing.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($existing.Description -ne $description -or $ownerSid -ne $identity.User.Value) {
            throw 'Existing recovery task ownership does not match. No replacement or takeover.'
        }
    }
    return $existing
}
if ($Mode -eq 'Install') {
    $null = Get-OwnedTask
    $action = New-ScheduledTaskAction -Execute $powershell -WorkingDirectory $root -Argument (
        '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}"' -f $wrapper, $NodePath)
    $minute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
        -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($minute, $logon) `
        -Principal $principal -Settings $settings -Description $description -Force
} elseif ($Mode -eq 'Stop') {
    & $NodePath $module stop
    if ($LASTEXITCODE -ne 0) { throw 'Recovery config stop failed.' }
    if (Get-OwnedTask) { $null = Disable-ScheduledTask -TaskName $taskName }
} elseif ($Mode -eq 'Enable') {
    if (-not (Get-OwnedTask)) { throw 'Install the owned recovery task first.' }
    & $NodePath $module enable
    if ($LASTEXITCODE -ne 0) { throw 'Recovery config enable failed.' }
    $null = Enable-ScheduledTask -TaskName $taskName
}
$task = Get-OwnedTask
$info = if ($task) { Get-ScheduledTaskInfo -TaskName $taskName } else { $null }
[ordered]@{
    taskName = $taskName
    registered = [bool]$task
    state = if ($task) { [string]$task.State } else { 'Missing' }
    userId = if ($task) { $task.Principal.UserId } else { $null }
    logonType = if ($task) { [string]$task.Principal.LogonType } else { $null }
    runLevel = if ($task) { [string]$task.Principal.RunLevel } else { $null }
    hidden = if ($task) { $task.Settings.Hidden } else { $null }
    multipleInstances = if ($task) { [string]$task.Settings.MultipleInstances } else { $null }
    executionTimeLimit = if ($task) { $task.Settings.ExecutionTimeLimit } else { $null }
    actions = if ($task) { @($task.Actions | Select-Object Execute, Arguments, WorkingDirectory) } else { @() }
    triggers = if ($task) { @($task.Triggers | ForEach-Object { [ordered]@{ type = $_.CimClass.CimClassName; enabled = $_.Enabled;
        interval = $_.Repetition.Interval; duration = $_.Repetition.Duration; userId = $_.UserId } }) } else { @() }
    lastRunTime = if ($info) { $info.LastRunTime.ToString('o') } else { $null }
    lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
    nextRunTime = if ($info) { $info.NextRunTime.ToString('o') } else { $null }
} | ConvertTo-Json -Depth 8
