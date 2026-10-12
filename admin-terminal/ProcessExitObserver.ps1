if(-not ('CodexAdmin.ProcessExitObserver' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;
namespace CodexAdmin {
  public sealed class ProcessExitObserver : IDisposable {
    sealed class ProcessWait : WaitHandle {
      [DllImport("kernel32.dll", SetLastError=true)]
      static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
      public ProcessWait(int pid) {
        // Read-only synchronization; do not request PROCESS_ALL_ACCESS or change a process DACL.
        var handle = OpenProcess(0x00100000, false, pid);
        if(handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        SafeWaitHandle = new SafeWaitHandle(handle, true);
      }
    }
    readonly ProcessWait process;
    RegisteredWaitHandle registration;
    public event EventHandler Exited;
    public ProcessExitObserver(int pid) { process = new ProcessWait(pid); }
    public void Start() {
      if(registration != null) throw new InvalidOperationException("Observer already started.");
      registration = ThreadPool.RegisterWaitForSingleObject(process,
        (state, timeout) => { var handler = Exited; if(handler != null) handler(this, EventArgs.Empty); },
        null, Timeout.Infinite, true);
    }
    public bool HasExited { get { return process.WaitOne(0); } }
    public void Dispose() { if(registration != null) registration.Unregister(null); process.Dispose(); }
  }
}
'@
}
