param([switch]$Devices, [switch]$Ownership)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Ownership) { Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MemoryToolEnvironment {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] data, int size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int kind, IntPtr[] data, int size, out int returned);
  static byte[] Read(IntPtr h, long address, int size) {
    byte[] data = new byte[size]; IntPtr read;
    if (!ReadProcessMemory(h, new IntPtr(address), data, size, out read) || read.ToInt64() != size) throw new Exception("unreadable process memory");
    return data;
  }
  public static string ThreadId(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      IntPtr[] info = new IntPtr[6]; int returned;
      if (NtQueryInformationProcess(h, 0, info, 48, out returned) != 0) return null;
      long parameters = BitConverter.ToInt64(Read(h, info[1].ToInt64() + 0x20, 8), 0);
      long environment = BitConverter.ToInt64(Read(h, parameters + 0x80, 8), 0);
      StringBuilder entry = new StringBuilder(); bool previousNull = false; string found = null;
      for (int offset = 0; offset < 1048576;) {
        int size = 4096 - (int)((environment + offset) % 4096);
        byte[] block = Read(h, environment + offset, size);
        for (int index = 0; index + 1 < block.Length; index += 2) {
          char c = (char)BitConverter.ToUInt16(block, index);
          if (c == 0) {
            if (previousNull) return found;
            string value = entry.ToString();
            foreach (string key in new [] { "CODEX_THREAD_ID=", "CODEX_SESSION_ID=" }) {
              if (value.StartsWith(key, StringComparison.OrdinalIgnoreCase)) {
                Guid id;
                if (Guid.TryParse(value.Substring(key.Length), out id)) {
                  if (found != null && found != id.ToString()) return null;
                  found = id.ToString();
                }
              }
            }
            entry.Clear(); previousNull = true;
          } else { entry.Append(c); previousNull = false; }
        }
        offset += size;
      }
      return null;
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@
}
[Console]::Error.WriteLine('Collecting Win32_Process' + $(if ($Ownership) { ' and thread IDs' } else { '' }))
$capturedAt = [DateTime]::UtcNow.ToString('o')
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  $p = $_
  $thread = $null
  if ($Ownership -and $p.Name -in @('node_repl.exe','codex.exe')) { $thread = [MemoryToolEnvironment]::ThreadId([int]$p.ProcessId) }
  [pscustomobject]@{
    pid = [int]$p.ProcessId; parentPid = [int]$p.ParentProcessId; name = $p.Name
    startedAt = $(if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { $null })
    executablePath = $p.ExecutablePath; commandLine = $p.CommandLine
    privateBytes = $(if ($null -ne $p.PrivatePageCount) { [double]$p.PrivatePageCount } else { $null })
    workingSetBytes = $(if ($null -ne $p.WorkingSetSize) { [double]$p.WorkingSetSize } else { $null })
    cpuSeconds = $(if ($null -ne $p.KernelModeTime -and $null -ne $p.UserModeTime) { ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 10000000 } else { $null })
    sessionId = [int]$p.SessionId; environmentThreadId = $thread
  }
})
$deviceRows = @(); $deviceError = $null
if ($Devices) {
  [Console]::Error.WriteLine('Collecting PnP/WUDF device metadata')
  try {
    $deviceRows = @(Get-CimInstance Win32_PnPEntity | ForEach-Object {
      $device = $_; $hostPid = $null
      # Read available device-specific WUDF metadata; absent PID evidence stays unknown.
      $wudf = $null
      try { $wudf = Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Enum\' + $device.PNPDeviceID + '\Device Parameters\WUDF') -ErrorAction Stop } catch {}
      if ($wudf) {
        foreach ($key in @('HostProcessId','HostProcessID','ProcessId')) {
          if ($wudf.PSObject.Properties[$key]) { $hostPid = [int]$wudf.$key; break }
        }
      }
      [pscustomobject]@{ instanceId=$device.PNPDeviceID; name=$device.Name; service=$device.Service; class=$device.PNPClass; hostPid=$hostPid; wudfProperties=$(if ($wudf) { @($wudf.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { @{name=$_.Name;value=$_.Value} }) } else { @() }) }
    })
  } catch { $deviceError = $_.Exception.Message }
}
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{ capturedAt=$capturedAt; processes=$rows; devices=$deviceRows; deviceError=$deviceError; physicalBytes=([double]$os.TotalVisibleMemorySize * 1024); availableBytes=([double]$os.FreePhysicalMemory * 1024) } | ConvertTo-Json -Depth 8 -Compress
