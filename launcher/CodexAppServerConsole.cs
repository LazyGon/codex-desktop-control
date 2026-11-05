using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public static class CodexAppServerConsole
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);

    // Called only from the disposable sender, never from the supervisor.
    public static void RequestShutdown(int processId, string executable, long startedUtcTicks)
    {
        using (var target = Process.GetProcessById(processId))
        using (var sender = Process.GetCurrentProcess())
        {
            if (target.SessionId != sender.SessionId || target.HasExited ||
                target.StartTime.ToUniversalTime().Ticks != startedUtcTicks ||
                !String.Equals(target.MainModule.FileName, Path.GetFullPath(executable),
                    StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The admitted AppServer identity changed.");

            FreeConsole();
            Check(AttachConsole((uint)processId));
            try
            {
                Check(SetConsoleCtrlHandler(IntPtr.Zero, true));
                var peers = new uint[2];
                uint count = GetConsoleProcessList(peers, (uint)peers.Length);
                Check(count != 0);
                if (count != 2 || !Array.Exists(peers, id => id == (uint)processId) ||
                    !Array.Exists(peers, id => id == (uint)sender.Id) || target.HasExited)
                    throw new InvalidOperationException("AppServer does not have an isolated console.");

                // CTRL+C is console-wide on Windows. Never send twice: the second
                // signal bypasses the AppServer's graceful drain.
                Check(GenerateConsoleCtrlEvent(0, 0));
            }
            finally { FreeConsole(); }
        }
    }

    private static void Check(bool ok)
    {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
