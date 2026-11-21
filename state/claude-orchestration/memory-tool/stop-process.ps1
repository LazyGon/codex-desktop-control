param([Parameter(Mandatory=$true)][string]$TargetFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$target = Get-Content -LiteralPath $TargetFile -Raw | ConvertFrom-Json
if ($target.name -notmatch '^(node|cua_node|node_repl|git)\.exe$' -or $target.pid -le 4) { throw 'Process type is not allowed' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MemoryToolStop {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint exitCode);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  public static void Stop(int pid, long createdAt, string image, double sampledCpuSeconds) {
    IntPtr handle = OpenProcess(0x101001, false, pid);
    if (handle == IntPtr.Zero) throw new Exception("Cannot open target: " + Marshal.GetLastWin32Error());
    try {
      long created, exited, kernel, user;
      StringBuilder actual = new StringBuilder(32768); int size = actual.Capacity;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)
        || !QueryFullProcessImageName(handle, 0, actual, ref size)) throw new Exception("Cannot read target identity");
      if (Math.Abs(created - createdAt) > 9 || !String.Equals(actual.ToString(), image, StringComparison.OrdinalIgnoreCase)) throw new Exception("Target identity changed");
      double cpuSeconds = (kernel + user) / 10000000.0;
      if (cpuSeconds < sampledCpuSeconds || cpuSeconds - sampledCpuSeconds > 0.05) throw new Exception("Target CPU increased since eligibility sample");
      if (!TerminateProcess(handle, 1)) throw new Exception("Termination failed: " + Marshal.GetLastWin32Error());
      if (WaitForSingleObject(handle, 5000) != 0) throw new Exception("Termination confirmation unavailable");
    } finally { CloseHandle(handle); }
  }
}
'@
$createdAt = [DateTime]::Parse($target.startedAt).ToUniversalTime().ToFileTimeUtc()
[MemoryToolStop]::Stop([int]$target.pid, $createdAt, [string]$target.executablePath, [double]$target.cpuSeconds)
@{pid=$target.pid; exited=$true} | ConvertTo-Json -Compress
