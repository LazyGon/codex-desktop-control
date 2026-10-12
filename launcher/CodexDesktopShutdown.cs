using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Application-only normal shutdown. Never registers files/services, requests an
// OS restart, enables RmForceShutdown, or falls back to process termination.
public static class CodexDesktopShutdown
{
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess
    {
        public uint Id;
        public System.Runtime.InteropServices.ComTypes.FILETIME Started;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo
    {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
        public uint AppType, Status, Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint RmStartSession(out uint session, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint RmRegisterResources(uint session, uint files, string[] names,
        uint apps, UniqueProcess[] processes, uint services, string[] serviceNames);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint RmGetList(uint session, out uint needed, ref uint count,
        [In, Out] ProcessInfo[] apps, out uint rebootReasons);
    [DllImport("rstrtmgr.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint RmShutdown(uint session, uint flags, IntPtr callback);
    [DllImport("rstrtmgr.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint RmEndSession(uint session);

    public sealed class Result
    {
        public int ProcessId;
        public bool ShutdownRequested;
        public uint ReturnCode;
        public int[] AffectedProcessIds;
    }
    private static void Check(uint code, string operation)
    {
        if (code != 0) throw new InvalidOperationException(operation + " failed: " + code);
    }
    private static UniqueProcess Identify(int processId, string executable, long startUtcTicks)
    {
        using (var process = Process.GetProcessById(processId))
        using (var caller = Process.GetCurrentProcess())
        {
            if (process.HasExited || process.SessionId != caller.SessionId ||
                process.StartTime.ToUniversalTime().Ticks != startUtcTicks ||
                !String.Equals(process.MainModule.FileName, Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The admitted Desktop process identity changed.");
            long fileTime = process.StartTime.ToUniversalTime().ToFileTimeUtc();
            return new UniqueProcess { Id = (uint)processId,
                Started = new System.Runtime.InteropServices.ComTypes.FILETIME {
                    dwLowDateTime = unchecked((int)fileTime), dwHighDateTime = (int)(fileTime >> 32) } };
        }
    }
    public static Result Run(int processId, string executable, long startUtcTicks, bool execute)
    {
        var target = Identify(processId, executable, startUtcTicks);
        uint session;
        Check(RmStartSession(out session, 0, new StringBuilder(33)), "RmStartSession");
        try
        {
            Check(RmRegisterResources(session, 0, null, 1, new[] { target }, 0, null), "RmRegisterResources");
            uint needed, count = 0, reasons;
            uint code = RmGetList(session, out needed, ref count, null, out reasons);
            if (code != 0 && code != 234) Check(code, "RmGetList");
            if (reasons != 0 || needed != 1)
                throw new InvalidOperationException("Normal shutdown must affect exactly the admitted Desktop and require no OS restart.");
            var affected = new ProcessInfo[needed];
            count = needed;
            Check(RmGetList(session, out needed, ref count, affected, out reasons), "RmGetList");
            if (reasons != 0 || count != 1 || affected[0].Process.Id != target.Id ||
                affected[0].Process.Started.dwHighDateTime != target.Started.dwHighDateTime ||
                affected[0].Process.Started.dwLowDateTime != target.Started.dwLowDateTime ||
                affected[0].AppType != 1 || !String.IsNullOrEmpty(affected[0].Service))
                throw new InvalidOperationException("Restart Manager reported an unrelated process, service, or non-GUI target.");
            Identify(processId, executable, startUtcTicks);
            var result = new Result { ProcessId = processId, AffectedProcessIds = new[] { processId }, ShutdownRequested = execute };
            // flags=0 explicitly excludes RmForceShutdown. A veto/failure is
            // recorded, never followed by a forced close or another attempt.
            if (execute) result.ReturnCode = RmShutdown(session, 0, IntPtr.Zero);
            return result;
        }
        finally { RmEndSession(session); }
    }
}
