using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace CodexRestartSignIn {
    public static class NativeRestart {
        // Microsoft WinSDK winreg.h: RESTART=4, ARSO=0x2000. No force/restart-apps/update flags.
        public const uint Flags = 0x00002004;
        public const uint Reason = 0x80040001;
        [StructLayout(LayoutKind.Sequential)] struct Luid { public uint LowPart; public int HighPart; }
        [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out Luid luid);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disableAll,ref TokenPrivileges state,uint length,IntPtr previous,IntPtr returned);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true,SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint InitiateShutdownW(string machine,string message,uint grace,uint flags,uint reason);
        public static bool ExportAvailable() { return GetProcAddress(GetModuleHandle("advapi32.dll"),"InitiateShutdownW") != IntPtr.Zero; }
        public static uint RequestOneRestart() {
            IntPtr token;
            if(!OpenProcessToken(GetCurrentProcess(),0x28,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                Luid luid;
                if(!LookupPrivilegeValue(null,"SeShutdownPrivilege",out luid)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var state=new TokenPrivileges {Count=1,Luid=luid,Attributes=2};
                if(!AdjustTokenPrivileges(token,false,ref state,0,IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                int error=Marshal.GetLastWin32Error();
                if(error!=0) throw new Win32Exception(error); // Never grant a missing user right.
                return InitiateShutdownW(null,null,0,Flags,Reason);
            } finally {CloseHandle(token);}
        }
    }
}
