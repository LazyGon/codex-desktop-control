[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8798,

    [switch]$SelfTest,

    [switch]$NoSound,

    [switch]$NoDialogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherRoot = Split-Path -Parent $PSCommandPath
$logRoot = Join-Path $launcherRoot 'logs'
$stateRoot = Join-Path $launcherRoot 'state'
$cacheRoot = Join-Path $launcherRoot 'cache'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

$runStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$modeName = if ($SelfTest) { 'selftest' } else { 'desktop' }
$logPath = Join-Path $logRoot "$runStamp-$modeName.log"
$serverStdoutPath = Join-Path $logRoot "$runStamp-app-server.stdout.log"
$serverStderrPath = Join-Path $logRoot "$runStamp-app-server.stderr.log"
$statePath = Join-Path $stateRoot 'current.json'

function Write-LauncherLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffK'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Show-LauncherMessage {
    param(
        [Parameter(Mandatory)][string]$Message,
        [int]$Icon = 48,
        [int]$TimeoutSeconds = 30
    )

    if ($NoDialogs) {
        return
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message, $TimeoutSeconds, 'Codex Shared Server', $Icon)
    }
    catch {
        Write-LauncherLog "Unable to show message dialog: $($_.Exception.Message)"
    }
}

function Invoke-LauncherSignal {
    param([ValidateSet('Ready', 'Stopped', 'Error')][string]$Kind)

    if ($NoSound) {
        return
    }

    try {
        switch ($Kind) {
            'Ready' {
                [Console]::Beep(880, 140)
                Start-Sleep -Milliseconds 90
                [Console]::Beep(1175, 180)
            }
            'Stopped' {
                [Console]::Beep(740, 130)
                Start-Sleep -Milliseconds 80
                [Console]::Beep(523, 180)
            }
            'Error' {
                [Console]::Beep(330, 250)
            }
        }
    }
    catch {
        [System.Media.SystemSounds]::Exclamation.Play()
    }
}

function Get-CodexPackageInfo {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' |
        Sort-Object { [version]$_.Version } -Descending |
        Select-Object -First 1

    if ($null -eq $package) {
        throw 'OpenAI.Codex is not installed for the current Windows user.'
    }

    $desktopExecutable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    $bundledServerExecutable = Join-Path $package.InstallLocation 'app\resources\codex.exe'
    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
        throw "Desktop executable was not found: $desktopExecutable"
    }
    if (-not (Test-Path -LiteralPath $bundledServerExecutable -PathType Leaf)) {
        throw "Bundled app-server executable was not found: $bundledServerExecutable"
    }

    $sourceHash = (Get-FileHash -LiteralPath $bundledServerExecutable -Algorithm SHA256).Hash
    $cachedServerExecutable = Join-Path $cacheRoot ("codex-{0}.exe" -f $package.Version.ToString())
    $cacheIsCurrent = $false
    if (Test-Path -LiteralPath $cachedServerExecutable -PathType Leaf) {
        $cachedHash = (Get-FileHash -LiteralPath $cachedServerExecutable -Algorithm SHA256).Hash
        $cacheIsCurrent = $cachedHash -eq $sourceHash
    }

    if (-not $cacheIsCurrent) {
        $temporaryCachePath = "$cachedServerExecutable.$PID.tmp"
        try {
            Copy-Item -LiteralPath $bundledServerExecutable -Destination $temporaryCachePath -Force
            $temporaryHash = (Get-FileHash -LiteralPath $temporaryCachePath -Algorithm SHA256).Hash
            if ($temporaryHash -ne $sourceHash) {
                throw 'The cached app-server hash does not match the Desktop package.'
            }
            Move-Item -LiteralPath $temporaryCachePath -Destination $cachedServerExecutable -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporaryCachePath) {
                Remove-Item -LiteralPath $temporaryCachePath -Force
            }
        }
    }

    [pscustomobject]@{
        Version = $package.Version.ToString()
        PackageFamilyName = $package.PackageFamilyName
        ApplicationUserModelId = "$($package.PackageFamilyName)!App"
        InstallLocation = $package.InstallLocation
        DesktopExecutable = [IO.Path]::GetFullPath($desktopExecutable)
        BundledServerExecutable = [IO.Path]::GetFullPath($bundledServerExecutable)
        ServerExecutable = [IO.Path]::GetFullPath($cachedServerExecutable)
        ServerSha256 = $sourceHash
    }
}

function Set-UserWebSocketEnvironment {
    param([Parameter(Mandatory)][string]$WebSocketUrl)

    $currentValue = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
    if ($currentValue -ne $WebSocketUrl) {
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $WebSocketUrl, 'User')
    }
    $env:CODEX_APP_SERVER_WS_URL = $WebSocketUrl

    if (-not ('CodexSharedLauncher.EnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexSharedLauncher
{
    public static class EnvironmentBroadcast
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr window, uint message, IntPtr wParam, string lParam,
            uint flags, uint timeout, out IntPtr result);

        public static void Notify()
        {
            IntPtr result;
            SendMessageTimeout(new IntPtr(0xffff), 0x001A, IntPtr.Zero,
                "Environment", 0x0002, 5000, out result);
        }
    }
}
'@
    }
    [CodexSharedLauncher.EnvironmentBroadcast]::Notify()
}

function Clear-UserWebSocketEnvironment {
    param([Parameter(Mandatory)][string]$ExpectedWebSocketUrl)

    $currentValue = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
    if ($currentValue -eq $ExpectedWebSocketUrl) {
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
        Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
        [CodexSharedLauncher.EnvironmentBroadcast]::Notify()
    }
}

function Get-CodexDesktopRootProcesses {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    $pattern = '^"?' + [regex]::Escape($DesktopExecutable) + '"?(?:\s|$)'
    @(
        Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -match $pattern -and
                $_.CommandLine -notmatch '(?:^|\s)--type='
            }
    )
}

function Get-CodexDesktopProcessIds {
    param([Parameter(Mandatory)][string]$DesktopExecutable)

    $pattern = '^"?' + [regex]::Escape($DesktopExecutable) + '"?(?:\s|$)'
    @(
        Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } |
            ForEach-Object { [int]$_.ProcessId }
    )
}

function Get-DesktopLocalAppServers {
    param([int[]]$DesktopRootProcessIds)

    if ($DesktopRootProcessIds.Count -eq 0) {
        return @()
    }

    @(
        Get-CimInstance Win32_Process -Filter "Name='codex.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $DesktopRootProcessIds -contains [int]$_.ParentProcessId -and
                $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and
                $_.CommandLine -notmatch '--listen\s+ws://'
            }
    )
}

function Assert-PortAvailable {
    param([Parameter(Mandatory)][int]$PortNumber)

    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $PortNumber)
    $probe.Server.ExclusiveAddressUse = $true
    try {
        $probe.Start()
    }
    catch {
        throw "TCP port 127.0.0.1:$PortNumber is already in use. No process was stopped."
    }
    finally {
        $probe.Stop()
    }
}

function Wait-AppServerReady {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory)][int]$PortNumber,
        [int]$TimeoutSeconds = 30
    )

    $uri = "http://127.0.0.1:$PortNumber/readyz"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if ($Process.HasExited) {
            $stderrTail = if (Test-Path -LiteralPath $serverStderrPath) {
                (Get-Content -LiteralPath $serverStderrPath -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
            }
            else {
                ''
            }
            throw "app-server exited before it became ready (exit $($Process.ExitCode)). $stderrTail"
        }

        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                return
            }
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    }

    throw "app-server did not become ready within $TimeoutSeconds seconds: $uri"
}

function Test-DesktopWebSocketConnection {
    param(
        [Parameter(Mandatory)][string]$DesktopExecutable,
        [Parameter(Mandatory)][int]$PortNumber
    )

    $desktopProcessIds = @(Get-CodexDesktopProcessIds -DesktopExecutable $DesktopExecutable)
    if ($desktopProcessIds.Count -eq 0) {
        return $false
    }

    $connections = @(
        Get-NetTCPConnection -State Established -RemotePort $PortNumber -ErrorAction SilentlyContinue |
            Where-Object {
                $_.RemoteAddress -in @('127.0.0.1', '::ffff:127.0.0.1', '::1') -and
                $desktopProcessIds -contains [int]$_.OwningProcess
            }
    )
    $connections.Count -gt 0
}

function Write-RuntimeState {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$State)

    $temporaryPath = "$statePath.tmp"
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Remove-RuntimeStateIfOwned {
    param([int]$ExpectedServerProcessId)

    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return
    }

    try {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$state.serverProcessId -eq $ExpectedServerProcessId) {
            Remove-Item -LiteralPath $statePath -Force
        }
    }
    catch {
        Write-LauncherLog "Unable to inspect or remove runtime state: $($_.Exception.Message)"
    }
}

if (-not ('CodexSharedLauncher.KillOnCloseJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CodexSharedLauncher
{
    public sealed class KillOnCloseJob : IDisposable
    {
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private IntPtr handle;

        public KillOnCloseJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error());

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                if (!SetInformationJobObject(handle, 9, pointer, (uint)length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            catch
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        public void AddProcess(Process process)
        {
            if (handle == IntPtr.Zero)
                throw new ObjectDisposedException("KillOnCloseJob");
            if (!AssignProcessToJobObject(handle, process.Handle))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
            GC.SuppressFinalize(this);
        }

        ~KillOnCloseJob()
        {
            Dispose();
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
'@
}

$mutex = $null
$ownsMutex = $false
$jobObject = $null
$serverProcess = $null
$serverProcessId = 0
$exitCode = 1
$packageInfo = $null
$registeredWebSocketUrl = $null

try {
    $mutexName = "Local\CodexSharedServerLauncher-$Port"
    $mutex = [Threading.Mutex]::new($false, $mutexName)
    try {
        $ownsMutex = $mutex.WaitOne(0)
    }
    catch [Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw "Another Codex Shared Server launcher already owns port $Port."
    }

    $packageInfo = Get-CodexPackageInfo
    Write-LauncherLog "Launcher started. mode=$modeName port=$Port package=$($packageInfo.Version)"

    $existingDesktopRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $packageInfo.DesktopExecutable)
    if (-not $SelfTest -and $existingDesktopRoots.Count -gt 0) {
        $processList = ($existingDesktopRoots.ProcessId -join ', ')
        Write-LauncherLog "Desktop is already running. pid=$processList. No process was stopped."
        Show-LauncherMessage -Message "Codex Desktop is already running (PID $processList).`n`nQuit Codex normally, then click Codex Shared Server again. No process was stopped." -Icon 48
        $exitCode = 2
    }
    else {
        Assert-PortAvailable -PortNumber $Port

        $serverArguments = @(
            '-c',
            'features.code_mode_host=true',
            'app-server',
            '--listen',
            "ws://127.0.0.1:$Port",
            '--analytics-default-enabled'
        )
        $serverStartParameters = @{
            FilePath = $packageInfo.ServerExecutable
            ArgumentList = $serverArguments
            WindowStyle = 'Hidden'
            RedirectStandardOutput = $serverStdoutPath
            RedirectStandardError = $serverStderrPath
            PassThru = $true
        }
        $serverProcess = Start-Process @serverStartParameters
        $serverProcessId = $serverProcess.Id

        $jobObject = [CodexSharedLauncher.KillOnCloseJob]::new()
        $jobObject.AddProcess($serverProcess)
        Write-LauncherLog "app-server started and assigned to job. pid=$serverProcessId"

        Wait-AppServerReady -Process $serverProcess -PortNumber $Port
        Write-LauncherLog "app-server ready. url=ws://127.0.0.1:$Port"

        $runtimeState = [ordered]@{
            schemaVersion = 1
            mode = $modeName
            websocketUrl = "ws://127.0.0.1:$Port"
            readyUrl = "http://127.0.0.1:$Port/readyz"
            port = $Port
            serverProcessId = $serverProcessId
            supervisorProcessId = $PID
            desktopProcessIds = @()
            desktopConnectionVerified = $false
            packageVersion = $packageInfo.Version
            desktopExecutable = $packageInfo.DesktopExecutable
            bundledServerExecutable = $packageInfo.BundledServerExecutable
            serverExecutable = $packageInfo.ServerExecutable
            serverSha256 = $packageInfo.ServerSha256
            startedAt = (Get-Date).ToString('o')
            logPath = $logPath
        }
        Write-RuntimeState -State $runtimeState

        if ($SelfTest) {
            $readyResponse = Invoke-WebRequest -UseBasicParsing -Uri $runtimeState.readyUrl -TimeoutSec 2
            if ($readyResponse.StatusCode -ne 200) {
                throw "Self-test ready endpoint returned HTTP $($readyResponse.StatusCode)."
            }
            Write-LauncherLog 'SELFTEST_OK app-server accepted connections and returned HTTP 200.'
            Write-Output "SELFTEST_OK port=$Port serverPid=$serverProcessId log=$logPath"
            $exitCode = 0
        }
        else {
            Set-UserWebSocketEnvironment -WebSocketUrl $runtimeState.websocketUrl
            $registeredWebSocketUrl = $runtimeState.websocketUrl
            Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_APP_SERVER_USE_LOCAL_DAEMON -ErrorAction SilentlyContinue

            $appsFolderTarget = "shell:AppsFolder\$($packageInfo.ApplicationUserModelId)"
            Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList $appsFolderTarget | Out-Null
            Write-LauncherLog "Desktop package activation requested. appId=$($packageInfo.ApplicationUserModelId)"

            $desktopRoots = @()
            $launchWatch = [Diagnostics.Stopwatch]::StartNew()
            while ($launchWatch.Elapsed.TotalSeconds -lt 30) {
                $desktopRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $packageInfo.DesktopExecutable)
                if ($desktopRoots.Count -gt 0) {
                    break
                }
                Start-Sleep -Milliseconds 250
            }
            if ($desktopRoots.Count -eq 0) {
                throw 'Codex Desktop did not start within 30 seconds.'
            }

            $runtimeState['desktopProcessIds'] = @($desktopRoots | ForEach-Object { [int]$_.ProcessId })
            Write-RuntimeState -State $runtimeState
            Write-LauncherLog "Desktop root detected. pid=$($runtimeState.desktopProcessIds -join ',')"

            $connectionVerified = $false
            $connectionWatch = [Diagnostics.Stopwatch]::StartNew()
            while ($connectionWatch.Elapsed.TotalSeconds -lt 30) {
                if (Test-DesktopWebSocketConnection -DesktopExecutable $packageInfo.DesktopExecutable -PortNumber $Port) {
                    $connectionVerified = $true
                    break
                }

                $currentRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $packageInfo.DesktopExecutable)
                $rootIds = @($currentRoots | ForEach-Object { [int]$_.ProcessId })
                $localServers = @(Get-DesktopLocalAppServers -DesktopRootProcessIds $rootIds)
                if ($localServers.Count -gt 0) {
                    Write-LauncherLog "Desktop spawned a private stdio app-server instead of using WebSocket. pid=$($localServers.ProcessId -join ',')"
                    break
                }
                Start-Sleep -Milliseconds 500
            }

            if (-not $connectionVerified) {
                Show-LauncherMessage -Message "Codex started, but the shared app-server connection could not be verified.`n`nCodex remains open. See:`n$logPath" -Icon 16
                throw 'Desktop WebSocket connection was not verified.'
            }

            $runtimeState['desktopConnectionVerified'] = $true
            $runtimeState['desktopProcessIds'] = Get-CodexDesktopProcessIds -DesktopExecutable $packageInfo.DesktopExecutable
            Write-RuntimeState -State $runtimeState
            Write-LauncherLog 'Desktop WebSocket connection verified.'
            Invoke-LauncherSignal -Kind Ready

            $missingSince = $null
            while ($true) {
                $currentRoots = @(Get-CodexDesktopRootProcesses -DesktopExecutable $packageInfo.DesktopExecutable)
                if ($currentRoots.Count -gt 0) {
                    $missingSince = $null
                }
                elseif ($null -eq $missingSince) {
                    $missingSince = Get-Date
                }
                elseif (((Get-Date) - $missingSince).TotalSeconds -ge 10) {
                    break
                }
                Start-Sleep -Seconds 1
            }

            Write-LauncherLog 'Desktop exited; beginning owned app-server cleanup.'
            $exitCode = 0
        }
    }
}
catch {
    Write-LauncherLog "ERROR $($_.Exception.Message)"
    if (-not $SelfTest) {
        Invoke-LauncherSignal -Kind Error
        Show-LauncherMessage -Message "Codex Shared Server could not complete startup.`n`n$($_.Exception.Message)`n`nLog:`n$logPath" -Icon 16
    }
    else {
        Write-Error $_
    }
    $exitCode = 1
}
finally {
    if ($null -ne $registeredWebSocketUrl) {
        try {
            Clear-UserWebSocketEnvironment -ExpectedWebSocketUrl $registeredWebSocketUrl
            Write-LauncherLog 'Transient user WebSocket environment removed.'
        }
        catch {
            Write-LauncherLog "Unable to remove transient user environment: $($_.Exception.Message)"
        }
    }

    if ($serverProcessId -ne 0) {
        Remove-RuntimeStateIfOwned -ExpectedServerProcessId $serverProcessId
    }

    if ($null -ne $jobObject) {
        Write-LauncherLog "Closing owned app-server job. pid=$serverProcessId"
        $jobObject.Dispose()
        if ($null -ne $serverProcess) {
            try {
                [void]$serverProcess.WaitForExit(5000)
                Write-LauncherLog "Owned app-server stopped. exited=$($serverProcess.HasExited)"
            }
            catch {
                Write-LauncherLog "Unable to confirm app-server exit: $($_.Exception.Message)"
            }
        }
    }
    elseif ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        # This fallback applies only to the exact process created by this invocation.
        Write-LauncherLog "Job assignment failed; stopping exact owned process. pid=$serverProcessId"
        Stop-Process -Id $serverProcessId -Force -ErrorAction SilentlyContinue
    }

    if ($ownsMutex -and $null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }

    if (-not $SelfTest -and $exitCode -eq 0) {
        Invoke-LauncherSignal -Kind Stopped
    }
    Write-LauncherLog "Launcher finished. exitCode=$exitCode"
}

exit $exitCode
