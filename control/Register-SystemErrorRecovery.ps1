param(
    [ValidateSet('Install', 'Status', 'Stop', 'Enable')][string]$Mode = 'Status',
    [string]$NodePath = (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
)
$ErrorActionPreference = 'Stop'
$taskName = 'Codex System Error Recovery'
$description = 'Codex Desktop Control: same-thread terminal system-error recovery; current user Limited; no settings or authority overrides.'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $PSScriptRoot 'Invoke-SystemErrorRecovery.ps1'
$module = Join-Path $PSScriptRoot 'system-error-recovery.mjs'
$pythonw = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/pythonw.exe'
$launcher = Join-Path $PSScriptRoot 'system-error-recovery-launcher.py'
if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Windowless recovery runtime or launcher is missing.' }
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
    $existing = Get-OwnedTask
    $action = New-ScheduledTaskAction -Execute $pythonw -WorkingDirectory $root -Argument (
        '"{0}" --mode run --node-path "{1}"' -f $launcher, $NodePath)
    $minute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    if ($existing) {
        # Preserve existing triggers, principal, settings and enabled/disabled state.
        $null = Set-ScheduledTask -TaskName $taskName -TaskPath $existing.TaskPath -Action $action
    } else {
        $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($minute, $logon) `
            -Principal $principal -Settings $settings -Description $description
    }
} elseif ($Mode -eq 'Stop') {
    & $wrapper -Mode stop -NodePath $NodePath
    if ($LASTEXITCODE -ne 0) { throw 'Recovery config stop failed.' }
    if (Get-OwnedTask) { $null = Disable-ScheduledTask -TaskName $taskName }
} elseif ($Mode -eq 'Enable') {
    if (-not (Get-OwnedTask)) { throw 'Install the owned recovery task first.' }
    & $wrapper -Mode enable -NodePath $NodePath
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
