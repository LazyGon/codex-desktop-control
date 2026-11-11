function Get-CodexComponentValue {
    param($Object, [string]$Name)
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { $Object.$Name }
}

function Read-CodexComponentJson {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    }
}

function Split-CodexComponentCommandLine {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { throw 'Process command line is unavailable.' }
    if (-not ('CodexComponentArguments' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexComponentArguments {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string command) {
        int count; IntPtr memory=CommandLineToArgvW(command,out count);
        if(memory==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try { var result=new string[count]; for(int i=0;i<count;i++)
            result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }
}
'@
    }
    [CodexComponentArguments]::Parse($CommandLine)
}

function Test-CodexComponentPath {
    param([string]$Actual, [string]$Expected)
    if (-not $Actual -or -not $Expected -or -not [IO.Path]::IsPathRooted($Actual) -or
        -not [IO.Path]::IsPathRooted($Expected)) { return $false }
    [string]::Equals([IO.Path]::GetFullPath($Actual), [IO.Path]::GetFullPath($Expected),
        [StringComparison]::OrdinalIgnoreCase)
}

function Test-CodexComponentScriptProcess {
    param($Row, [string]$ScriptPath)
    if ([IO.Path]::GetFileName([string]$Row.ExecutablePath) -notin @('powershell.exe','pwsh.exe')) { return $false }
    if (-not $Row.CommandLine) { return $false }
    $arguments = @(Split-CodexComponentCommandLine $Row.CommandLine)
    if (-not (Test-CodexComponentPath $arguments[0] $Row.ExecutablePath)) { return $false }
    for ($i = 1; $i -lt $arguments.Count - 1; $i++) {
        if ($arguments[$i] -ieq '-File') {
            return (Test-CodexComponentPath $arguments[$i + 1] $ScriptPath)
        }
        if ($arguments[$i] -in @('-Command','-EncodedCommand','-c','-e')) { return $false }
    }
    return $false
}

function Test-CodexSharedSupervisor {
    param($Row, [string]$LauncherRoot)
    if (-not (Test-CodexComponentScriptProcess $Row (Join-Path $LauncherRoot 'Start-CodexShared.ps1'))) { return $false }
    $arguments = @(Split-CodexComponentCommandLine $Row.CommandLine)
    for ($i=1; $i -lt $arguments.Count; $i++) {
        if ($arguments[$i] -imatch '^-SelfTest(?:$|:)') { return $false }
        if ($arguments[$i] -imatch '^-Port:(.*)$' -and $Matches[1] -cne '8798') { return $false }
        if ($arguments[$i] -ieq '-Port' -and ($i+1 -ge $arguments.Count -or $arguments[$i+1] -cne '8798')) { return $false }
    }
    return $true
}

function New-CodexComponentTarget {
    param($Row, [string]$Role)
    [pscustomobject]@{
        pid = [int]$Row.ProcessId; parentPid = [int]$Row.ParentProcessId
        executable = [string]$Row.ExecutablePath; commandLine = [string]$Row.CommandLine
        startedAt = ([datetime]$Row.CreationDate).ToUniversalTime().ToString('o')
        session = [int]$Row.SessionId; role = $Role
    }
}

function Select-CodexComponentTargets {
    param([string]$Component, [string]$LauncherRoot, $Snapshot)
    $rows = @($Snapshot.processes)
    $byId = @{}
    foreach ($row in $rows) { $byId[[int]$row.ProcessId] = $row }
    switch ($Component) {
        'Shared' {
            $state = $Snapshot.state
            if ($null -ne $state -and ((Get-CodexComponentValue $state 'websocketUrl') -cne 'ws://127.0.0.1:8798' -or
                [int](Get-CodexComponentValue $state 'port') -ne 8798)) {
                throw 'Canonical Shared endpoint is not exactly ws://127.0.0.1:8798.'
            }
            $cachePrefix = [IO.Path]::GetFullPath((Join-Path $LauncherRoot 'cache')) + [IO.Path]::DirectorySeparatorChar
            $supervisors = @($rows | Where-Object {
                Test-CodexSharedSupervisor $_ $LauncherRoot
            })
            $servers = @()
            foreach ($row in $rows) {
                if ([IO.Path]::GetFileName([string]$row.ExecutablePath) -ine 'codex.exe') { continue }
                $args = @(Split-CodexComponentCommandLine $row.CommandLine)
                if ($args -cnotcontains 'app-server') { continue }
                $listen = @(); for ($i=1; $i -lt $args.Count-1; $i++) {
                    if ($args[$i] -ceq '--listen') { $listen += $args[$i+1] }
                }
                if ($listen -cnotcontains 'ws://127.0.0.1:8798') { continue }
                if ($listen.Count -ne 1 -or -not (Test-CodexComponentPath $args[0] $row.ExecutablePath) -or
                    -not ([IO.Path]::GetFullPath($row.ExecutablePath).StartsWith($cachePrefix,[StringComparison]::OrdinalIgnoreCase))) {
                    throw 'The Shared listener command or executable does not belong to this launcher cache.'
                }
                $owner = @($supervisors | Where-Object { [int]$_.ProcessId -eq [int]$row.ParentProcessId })
                if ($owner.Count -ne 1 -or [datetime]$owner[0].CreationDate -gt [datetime]$row.CreationDate) {
                    throw 'The Shared process has no live, exact repository supervisor.'
                }
                $servers += $row
                New-CodexComponentTarget $row 'server'
            }
            foreach ($listener in @($Snapshot.listeners)) {
                if ([int]$listener.LocalPort -ne 8798) { continue }
                if ($listener.LocalAddress -cne '127.0.0.1' -or [int]$listener.OwningProcess -notin @($servers | ForEach-Object ProcessId)) {
                    throw 'Port 8798 has an unverified or non-exact-loopback listener.'
                }
            }
            if ($null -ne $state) {
                $recordedServer = [int](Get-CodexComponentValue $state 'serverProcessId')
                $recordedSupervisor = [int](Get-CodexComponentValue $state 'supervisorProcessId')
                if (($byId.ContainsKey($recordedServer) -and $recordedServer -notin @($servers | ForEach-Object ProcessId)) -or
                    ($byId.ContainsKey($recordedSupervisor) -and $recordedSupervisor -notin @($supervisors | ForEach-Object ProcessId))) {
                    throw 'A canonical Shared PID now identifies an unrelated process.'
                }
                foreach ($server in $servers) {
                    if ([int]$server.ProcessId -eq $recordedServer -and
                        -not (Test-CodexComponentPath $server.ExecutablePath (Get-CodexComponentValue $state 'serverExecutable'))) {
                        throw 'Canonical Shared executable differs from the live server.'
                    }
                }
            }
            foreach ($owner in $supervisors) {
                # An unhealthy launcher may be stuck before state publication or socket binding.
                New-CodexComponentTarget $owner 'supervisor'
            }
        }
        'Desktop' {
            $exe = [string]$Snapshot.desktopExecutable
            $desktopRows = @($rows | Where-Object { Test-CodexComponentPath $_.ExecutablePath $exe })
            $admitted = @{}
            foreach ($row in ($desktopRows | Sort-Object CreationDate)) {
                $args = @(Split-CodexComponentCommandLine $row.CommandLine)
                if (-not (Test-CodexComponentPath $args[0] $exe)) { throw 'Desktop command executable differs from the registered package.' }
                $isHelper = @($args | Where-Object { $_ -cmatch '^--type=' }).Count -gt 0
                if (-not $isHelper) {
                    $admitted[[int]$row.ProcessId] = $row
                    New-CodexComponentTarget $row 'desktop'
                }
                elseif ($admitted.ContainsKey([int]$row.ParentProcessId) -and
                    [datetime]$admitted[[int]$row.ParentProcessId].CreationDate -le [datetime]$row.CreationDate) {
                    $admitted[[int]$row.ProcessId] = $row
                    New-CodexComponentTarget $row 'desktop-helper'
                }
                else { throw 'A Desktop helper has no verified live package root ancestry.' }
            }
        }
        'Bridge' {
            $bridgeRoot = Join-Path (Split-Path -Parent $LauncherRoot) 'discord-bridge'
            $runtime = $Snapshot.runtime
            $lockId = [int]$Snapshot.lockPid
            $hostRows = @($rows | Where-Object {
                Test-CodexComponentPath $_.ExecutablePath (Join-Path $bridgeRoot 'CodexDiscordRemoteHost.exe')
            })
            $liveCandidates = @($rows | Where-Object {
                [IO.Path]::GetFileName([string]$_.ExecutablePath) -ieq 'node.exe' -and
                $byId.ContainsKey([int]$_.ParentProcessId) -and
                (Test-CodexComponentScriptProcess $byId[[int]$_.ParentProcessId] (Join-Path $bridgeRoot 'Start-DiscordBridge.ps1'))
            })
            if ($lockId -le 0) {
                if ($liveCandidates.Count -gt 0 -or ($null -ne $runtime -and $byId.ContainsKey([int](Get-CodexComponentValue $runtime 'pid')))) {
                    throw 'Bridge runtime still points to a live PID but its lock is missing.'
                }
                if ($hostRows.Count -gt 0) { throw 'A live Bridge host has no verifiable Node lock; no process was stopped.' }
                return
            }
            if (-not $byId.ContainsKey($lockId)) {
                if ($liveCandidates.Count -gt 0) { throw 'A live repository Bridge differs from the stale lock PID.' }
                if ($hostRows.Count -gt 0) { throw 'A live Bridge host has only a stale Node lock; no process was stopped.' }
                return
            }
            if (@($liveCandidates | Where-Object { [int]$_.ProcessId -ne $lockId }).Count -gt 0) {
                throw 'Multiple repository Bridge candidates make lock ownership ambiguous.'
            }
            $row = $byId[$lockId]
            if ($null -eq $runtime -or [int](Get-CodexComponentValue $runtime 'pid') -ne $lockId -or
                -not (Test-CodexComponentPath (Get-CodexComponentValue $runtime 'bridgeRoot') $bridgeRoot) -or
                -not (Test-CodexComponentPath $row.ExecutablePath $Snapshot.nodeExecutable)) {
                throw 'Bridge lock, runtime root, PID and recorded Node executable do not agree.'
            }
            if ([datetimeoffset]$runtime.startedAt -lt [datetimeoffset]([datetime]$row.CreationDate).ToUniversalTime() -or
                [datetime]$Snapshot.lockWrittenAt -lt ([datetime]$row.CreationDate).ToUniversalTime()) {
                throw 'Bridge metadata predates the current PID birth.'
            }
            $args = @(Split-CodexComponentCommandLine $row.CommandLine)
            if ($args.Count -ne 2 -or -not (Test-CodexComponentPath $args[0] $row.ExecutablePath)) {
                throw 'Bridge Node arguments differ from its exact entry point.'
            }
            $parent = $byId[[int]$row.ParentProcessId]
            if ($null -eq $parent -or -not (Test-CodexComponentScriptProcess $parent (Join-Path $bridgeRoot 'Start-DiscordBridge.ps1')) -or
                [datetime]$parent.CreationDate -gt [datetime]$row.CreationDate) { throw 'Bridge has no exact repository start-script parent.' }
            if ($args[1] -cne 'src\index.mjs' -and $args[1] -cne 'src/index.mjs' -and
                -not (Test-CodexComponentPath $args[1] (Join-Path $bridgeRoot 'src\index.mjs'))) {
                throw 'Bridge entry point belongs to a different repository.'
            }
            $task = $Snapshot.task
            if ($null -eq $task -or -not (Test-CodexComponentPath $task.executable (Join-Path $bridgeRoot 'CodexDiscordRemoteHost.exe')) -or
                -not (Test-CodexComponentPath $task.workingDirectory $bridgeRoot) -or $task.sid -cne $Snapshot.sid) {
                throw 'Bridge scheduled-task repository or owner is unverified.'
            }
            $hostRow = $byId[[int]$parent.ParentProcessId]
            if ($null -eq $hostRow -or -not (Test-CodexComponentPath $hostRow.ExecutablePath $task.executable) -or
                [datetime]$hostRow.CreationDate -gt [datetime]$parent.CreationDate) {
                throw 'Bridge start script is not descended from its registered host.'
            }
            New-CodexComponentTarget $row 'bridge'
            New-CodexComponentTarget $parent 'bridge-supervisor'
            New-CodexComponentTarget $hostRow 'bridge-host'
        }
        default { throw 'Unknown component.' }
    }
}

function Get-CodexComponentSnapshot {
    param([string]$Component, [string]$LauncherRoot)
    $snapshot = [pscustomobject]@{
        sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        session = [Diagnostics.Process]::GetCurrentProcess().SessionId
        processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        state = $null; listeners = @(); desktopExecutable = ''; runtime = $null
        lockPid = 0; lockWrittenAt = $null; nodeExecutable = ''; task = $null
    }
    if ($Component -eq 'Shared') {
        $snapshot.state = Read-CodexComponentJson (Join-Path $LauncherRoot 'state\current.json')
        $snapshot.listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 8798)
    }
    elseif ($Component -eq 'Desktop') {
        $package = Get-CodexDesktopPackageInfo -RequireTrustedRegistration
        $snapshot.desktopExecutable = $package.DesktopExecutable
    }
    else {
        $bridgeRoot = Join-Path (Split-Path -Parent $LauncherRoot) 'discord-bridge'
        $snapshot.runtime = Read-CodexComponentJson (Join-Path $bridgeRoot 'data\runtime.json')
        $lock = Join-Path $bridgeRoot 'data\bridge.lock'
        if (Test-Path -LiteralPath $lock -PathType Leaf) {
            $text = (Get-Content -LiteralPath $lock -Raw).Trim()
            if ($text -notmatch '^[1-9][0-9]*$') { throw 'Bridge lock PID is unreadable.' }
            $snapshot.lockPid = [int]$text
            $snapshot.lockWrittenAt = (Get-Item -LiteralPath $lock).LastWriteTimeUtc
        }
        $node = Read-CodexComponentJson (Join-Path $LauncherRoot 'state\node-runtime.json')
        $snapshot.nodeExecutable = [string](Get-CodexComponentValue $node 'nodeExecutable')
        if ($snapshot.lockPid -gt 0 -and $snapshot.lockPid -in @($snapshot.processes.ProcessId)) {
            $task = Get-ScheduledTask -TaskName 'Codex Discord Remote' -ErrorAction Stop
            if (@($task.Actions).Count -ne 1) { throw 'Bridge task action is ambiguous.' }
            $account = [Security.Principal.NTAccount]::new([string]$task.Principal.UserId)
            $snapshot.task = [pscustomobject]@{
                executable = $task.Actions[0].Execute; workingDirectory = $task.Actions[0].WorkingDirectory
                sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
            }
        }
    }
    $snapshot
}

function Assert-CodexComponentIdentity {
    param($Target, $Process, [string]$Sid, [int]$Session)
    if ($Process.HasExited) { return $false }
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Target.pid)" -ErrorAction Stop
    if ($null -eq $row) {
        if ($Process.HasExited) { return $false }
        throw 'The pinned process disappeared from the identity query.'
    }
    $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction Stop
    $ticks = $Process.StartTime.ToUniversalTime().Ticks
    $expectedTicks = [datetimeoffset]::Parse($Target.startedAt).UtcDateTime.Ticks
    if ($Target.pid -eq $PID -or $row.ProcessId -ne $Target.pid -or $owner.ReturnValue -ne 0 -or $owner.Sid -cne $Sid -or
        [int]$row.SessionId -ne $Session -or $Target.session -ne $Session -or $Process.SessionId -ne $Session -or
        [int]$row.ParentProcessId -ne $Target.parentPid -or $row.CommandLine -cne $Target.commandLine -or
        -not (Test-CodexComponentPath $row.ExecutablePath $Target.executable) -or
        -not (Test-CodexComponentPath $Process.Path $Target.executable) -or
        ($ticks - ($ticks % 10)) -ne $expectedTicks -or
        ([datetime]$row.CreationDate).ToUniversalTime().Ticks -ne $expectedTicks) {
        throw 'Process identity changed or belongs to another user/session. No termination is authorized.'
    }
    return $true
}

function Open-CodexComponentProcess {
    param($Target, [string]$Sid, [int]$Session)
    try { $process = [Diagnostics.Process]::GetProcessById($Target.pid) }
    catch [ArgumentException] { return $null }
    try {
        # Keep this handle until the final exit observation; never kill by a bare PID.
        $null = $process.Handle
        if (-not (Assert-CodexComponentIdentity $Target $process $Sid $Session)) { $process.Dispose(); return $null }
        if ($Target.role -in @('supervisor','bridge-supervisor')) {
            $windowsShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            if (-not (Test-CodexComponentPath $Target.executable $windowsShell)) {
                $signature = Get-AuthenticodeSignature -LiteralPath $Target.executable
                if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
                    $signature.SignerCertificate.Subject -notmatch '(?:^|,)\s*O=Microsoft Corporation(?:,|$)') {
                    throw 'The supervisor executable is not a verified Microsoft shell.'
                }
            }
        }
        return $process
    }
    catch {
        $failure = $_
        $exited = $false
        try { $exited = $process.HasExited } catch { }
        $process.Dispose()
        if ($exited) { return $null }
        throw $failure
    }
}
