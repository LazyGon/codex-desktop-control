param([Parameter(Mandatory)][string]$TemporaryRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexComponentIdentity.ps1')
. (Join-Path $PSScriptRoot 'CodexComponentStop.ps1')
$script:checks = 0
function Confirm($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Reject([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Confirm $rejected $Message
}
function Row([int]$Id, [int]$Parent, [string]$Exe, [string]$Command, [int]$Second=1) {
    [pscustomobject]@{ ProcessId=$Id; ParentProcessId=$Parent; ExecutablePath=$Exe; CommandLine=$Command
        CreationDate=[datetime]::Parse("2026-01-01T00:00:$('{0:d2}' -f $Second)Z").ToUniversalTime(); SessionId=1 }
}
$fixtureLauncher = Join-Path $TemporaryRoot 'launcher'
$null = [IO.Directory]::CreateDirectory((Join-Path $fixtureLauncher 'state'))
$shell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$start = Join-Path $fixtureLauncher 'Start-CodexShared.ps1'
$serverExe = Join-Path $fixtureLauncher 'cache\release\codex.exe'
$supervisor = Row 101 10 $shell ('"'+$shell+'" -NoProfile -File "'+$start+'"')
$server = Row 102 101 $serverExe ('"'+$serverExe+'" app-server --listen ws://127.0.0.1:8798') 2
$shared = [pscustomobject]@{ state=[pscustomobject]@{websocketUrl='ws://127.0.0.1:8798';port=8798
    serverProcessId=102;supervisorProcessId=101;serverExecutable=$serverExe}
    processes=@($supervisor,$server);listeners=@([pscustomobject]@{LocalPort=8798;LocalAddress='127.0.0.1';OwningProcess=102}) }
Confirm (@(Select-CodexComponentTargets Shared $fixtureLauncher $shared).Count -eq 2) 'Owned listener and supervisor were not selected.'
$shared.listeners=@()
Confirm (@(Select-CodexComponentTargets Shared $fixtureLauncher $shared).Count -eq 2) 'Unhealthy server without listener was incorrectly gated.'
$server.CommandLine += ' --listen ws://0.0.0.0:8798'
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'Duplicate/wildcard endpoint was admitted.'
$server.CommandLine='"'+$serverExe+'" app-server --listen ws://127.0.0.1:8798'
$supervisor.CommandLine='"'+$shell+'" -File "C:\another-repo\Start-CodexShared.ps1"'
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'Another repository supervisor was admitted.'
$supervisor.CommandLine='"'+$shell+'" -Command echo -File "'+$start+'"'
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'A script path inside command data was admitted.'
$supervisor.CommandLine='"'+$shell+'" -File "'+$start+'"'
$supervisor.CommandLine += ' -Port 8800'
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'A different-port supervisor was admitted.'
$supervisor.CommandLine='"'+$shell+'" -File "'+$start+'" -SelfTest'
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'A self-test supervisor was admitted.'
$supervisor.CommandLine='"'+$shell+'" -File "'+$start+'"'
$shared.listeners=@([pscustomobject]@{LocalPort=8798;LocalAddress='0.0.0.0';OwningProcess=102})
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'A non-loopback listener was admitted.'
$shared.listeners=@([pscustomobject]@{LocalPort=8798;LocalAddress='127.0.0.1';OwningProcess=999})
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'An unrelated listener PID was admitted.'
$shared.listeners=@(); $shared.processes=@()
Confirm (@(Select-CodexComponentTargets Shared $fixtureLauncher $shared).Count -eq 0) 'Exited Shared was not a no-op.'
$shared.processes=@(Row 102 10 'C:\unrelated.exe' 'C:\unrelated.exe')
Reject { Select-CodexComponentTargets Shared $fixtureLauncher $shared } 'A reused canonical PID was silently accepted.'
$exe='C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\ChatGPT.exe'
$desktop=Row 201 10 $exe ('"'+$exe+'"')
$helper=Row 202 201 $exe ('"'+$exe+'" --type=renderer') 2
$screen=[pscustomobject]@{desktopExecutable=$exe;processes=@($desktop,$helper,(Row 203 10 'C:\Other\ChatGPT.exe' 'C:\Other\ChatGPT.exe'))}
Confirm (@(Select-CodexComponentTargets Desktop $fixtureLauncher $screen).Count -eq 2) 'Desktop package ancestry was not exact.'
$helper.ParentProcessId=999
Reject { Select-CodexComponentTargets Desktop $fixtureLauncher $screen } 'Orphan package helper was admitted.'
$bridgeRoot=Join-Path $TemporaryRoot 'discord-bridge'
$hostExe=Join-Path $bridgeRoot 'CodexDiscordRemoteHost.exe'
$hostRow=Row 301 10 $hostExe ('"'+$hostExe+'"')
$bridgeParent=Row 302 301 $shell ('"'+$shell+'" -File "'+(Join-Path $bridgeRoot 'Start-DiscordBridge.ps1')+'"') 2
$nodeExe='C:\runtime\node.exe'
$nodeRow=Row 303 302 $nodeExe ('"'+$nodeExe+'" src\index.mjs') 3
$bridge=[pscustomobject]@{processes=@($hostRow,$bridgeParent,$nodeRow);sid='S-1-test';lockPid=303
    lockWrittenAt=[datetime]'2026-01-01T00:00:04Z';nodeExecutable=$nodeExe
    runtime=[pscustomobject]@{pid=303;bridgeRoot=$bridgeRoot;startedAt='2026-01-01T00:00:04Z'}
    task=[pscustomobject]@{executable=$hostExe;workingDirectory=$bridgeRoot;sid='S-1-test'} }
Confirm (@(Select-CodexComponentTargets Bridge $fixtureLauncher $bridge).Count -eq 3) 'Exact Bridge ownership was not admitted.'
$bridge.lockPid=0
Reject { Select-CodexComponentTargets Bridge $fixtureLauncher $bridge } 'A live Bridge with missing lock was reported absent.'
$bridge.lockPid=999
Reject { Select-CodexComponentTargets Bridge $fixtureLauncher $bridge } 'A live Bridge with stale lock was reported absent.'
$bridge.lockPid=303
$bridge.runtime.startedAt=[datetime]::Parse('2026-01-01T00:00:04Z').ToUniversalTime()
Confirm (@(Select-CodexComponentTargets Bridge $fixtureLauncher $bridge).Count -eq 3) 'A JSON date decoded by PowerShell was shifted to local time.'
$bridge.runtime.startedAt='2026-01-01T00:00:04Z'
$bridge.task.sid='S-1-other'
Reject { Select-CodexComponentTargets Bridge $fixtureLauncher $bridge } 'Another task owner was admitted.'
$bridge.task.sid='S-1-test'; $bridge.runtime.bridgeRoot='C:\other-repo\discord-bridge'
Reject { Select-CodexComponentTargets Bridge $fixtureLauncher $bridge } 'Another runtime repository was admitted.'
$bridge.runtime.bridgeRoot=$bridgeRoot; $bridge.runtime.startedAt='2026-01-01T00:00:01Z'
Reject { Select-CodexComponentTargets Bridge $fixtureLauncher $bridge } 'Bridge metadata predating PID birth was admitted.'
$bridge.runtime.startedAt='2026-01-01T00:00:04Z';$bridge.nodeExecutable='C:\other\node.exe'
Reject { Select-CodexComponentTargets Bridge $fixtureLauncher $bridge } 'An unrelated node executable was admitted.'
$bridge.nodeExecutable=$nodeExe;$nodeRow.CommandLine='"'+$nodeExe+'" C:\other\src\index.mjs'
Reject { Select-CodexComponentTargets Bridge $fixtureLauncher $bridge } 'An unrelated Node entry point was admitted.'
$senderFixture=Join-Path $TemporaryRoot 'sender.ps1'
[IO.File]::WriteAllText($senderFixture,"Write-Output ('x' * 20000); exit 0")
$senderResult=Invoke-CodexComponentSender $senderFixture @()
Confirm $senderResult.accepted 'A successful disposable sender was not accepted or its output pipe blocked.'
[IO.File]::WriteAllText($senderFixture,'exit 7')
$senderResult=Invoke-CodexComponentSender $senderFixture @()
Confirm (-not $senderResult.accepted -and $senderResult.exitCode -eq 7) 'A rejected disposable sender was recorded as accepted.'

# All OS effects below are confined to this disposable process. The production
# selector is fed a small snapshot; process identity and kill/exit remain real.
$child = Start-Process -FilePath $shell -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 90"' -WindowStyle Hidden -PassThru
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$realSnapshot = ${function:Get-CodexComponentSnapshot}
$realGraceful = ${function:Request-CodexComponentGraceful}
try {
    $childRow=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)"
    $target=New-CodexComponentTarget $childRow 'desktop'
    $pinned=Open-CodexComponentProcess $target $sid $session
    try {
        Confirm (Assert-CodexComponentIdentity $target $pinned $sid $session) 'Disposable identity was not accepted.'
        $target.startedAt='2000-01-01T00:00:00Z'
        Reject { Assert-CodexComponentIdentity $target $pinned $sid $session } 'PID reuse/start-time mismatch was accepted.'
        $target.startedAt=([datetime]$childRow.CreationDate).ToUniversalTime().ToString('o')
        $target.commandLine='"C:\unrelated.exe"'
        Reject { Assert-CodexComponentIdentity $target $pinned $sid $session } 'A changed live command identity was accepted.'
        $target.commandLine=$childRow.CommandLine
        $target.executable='C:\unrelated.exe'
        Reject { Assert-CodexComponentIdentity $target $pinned $sid $session } 'A mismatched executable was accepted.'
        $target.executable=$childRow.ExecutablePath
        Reject { Assert-CodexComponentIdentity $target $pinned 'S-1-5-999' $session } 'Another owner SID was accepted.'
        Reject { Assert-CodexComponentIdentity $target $pinned $sid ($session+1) } 'Another session was accepted.'
        Confirm (-not $pinned.HasExited) 'Identity rejection harmed the disposable process.'
    } finally { $pinned.Dispose() }
    $script:testSnapshot=[pscustomobject]@{sid=$sid;session=$session;desktopExecutable=$childRow.ExecutablePath;processes=@($childRow)}
    function Get-CodexComponentSnapshot { param($Component,$LauncherRoot) $script:testSnapshot }
    $script:requests=0
    function Request-CodexComponentGraceful { param($Entry,$LauncherRoot,$JournalPath)
        $script:requests++; throw 'Simulated sender transport outcome unknown.' }
    $op=[guid]::NewGuid();$resultPath=Join-Path $TemporaryRoot 'uncertain.json'
    $receipt=Invoke-CodexComponentStop Desktop $op $resultPath $fixtureLauncher -Force -GracefulTimeoutSeconds 0
    Confirm ($receipt.phase -eq 'unknown' -and $receipt.targets[0].gracefulRequested -and
        $null -eq $receipt.targets[0].gracefulAccepted -and -not $receipt.targets[0].forceRequested) 'Uncertain dispatch was not fenced.'
    Confirm (-not $child.HasExited) 'An uncertain graceful result fell through to force.'
    Reject { Invoke-CodexComponentStop Desktop $op (Join-Path $TemporaryRoot 'other-result.json') $fixtureLauncher -Force } 'An uncertain ID was replayed with another receipt path.'
    Confirm ($script:requests -eq 1) 'Uncertain request was dispatched again.'
    $persisted=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    Confirm ($persisted.phase -eq 'unknown' -and $persisted.operationId -eq $op.ToString('D')) 'Unknown result was not durably visible.'
    ${function:Request-CodexComponentGraceful}=$realGraceful
    $receipt=Invoke-CodexComponentStop Desktop ([guid]::NewGuid()) (Join-Path $TemporaryRoot 'normal-only.json') $fixtureLauncher -GracefulTimeoutSeconds 0
    Confirm ($receipt.phase -eq 'failed' -and $receipt.outcome -eq 'still-running' -and -not $child.HasExited) 'No-force request terminated a windowless process.'
    $receipt=Invoke-CodexComponentStop Desktop ([guid]::NewGuid()) (Join-Path $TemporaryRoot 'terminated.json') $fixtureLauncher -Force -GracefulTimeoutSeconds 0
    Confirm ($receipt.phase -eq 'completed' -and $receipt.targets[0].forceAccepted -and $receipt.targets[0].exited) 'Force acceptance was not followed by actual exit confirmation.'
    Confirm ($child.WaitForExit(5000)) 'Disposable process remained alive.'
    $script:testSnapshot.processes=@()
    $receipt=Invoke-CodexComponentStop Desktop ([guid]::NewGuid()) (Join-Path $TemporaryRoot 'noop.json') $fixtureLauncher
    Confirm ($receipt.phase -eq 'completed' -and $receipt.outcome -eq 'not-running') 'Absent target was not a normal no-op.'
    $existingPath=Join-Path $TemporaryRoot 'preserve.json'; [IO.File]::WriteAllText($existingPath,'unchanged')
    Reject { Invoke-CodexComponentStop Desktop ([guid]::NewGuid()) $existingPath $fixtureLauncher -Force } 'An existing receipt was overwritten.'
    Confirm (([IO.File]::ReadAllText($existingPath)) -ceq 'unchanged') 'Existing receipt content was changed.'
} finally {
    ${function:Get-CodexComponentSnapshot}=$realSnapshot
    ${function:Request-CodexComponentGraceful}=$realGraceful
    if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
    $child.Dispose()
}
[IO.File]::WriteAllText((Join-Path $TemporaryRoot 'test-report.json'),
    (@{completed=$true;contracts=$script:checks} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output "COMPONENT_STOP_OK contracts=$script:checks"
