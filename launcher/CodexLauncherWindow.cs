using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

internal sealed class CodexLauncherWindow : IDisposable
{
    private readonly Mutex mutex;
    private readonly EventWaitHandle show;
    private RegisteredWaitHandle registration;
    public bool OwnsWindow { get; private set; }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);

    public CodexLauncherWindow(string root)
    {
        string name;
        using (var sha = SHA256.Create())
        {
            string identity = WindowsIdentity.GetCurrent().User.Value + "|" +
                Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant();
            name = "Local\\CodexSharedLauncherProgress-" +
                BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(identity))).Replace("-", "");
        }
        show = new EventWaitHandle(false, EventResetMode.AutoReset, name + "-Show");
        mutex = new Mutex(false, name);
        try { OwnsWindow = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { OwnsWindow = true; }
    }

    public void RequestShow()
    {
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
        using (process)
        {
            try
            {
                if (process.Id != Process.GetCurrentProcess().Id &&
                    process.SessionId == Process.GetCurrentProcess().SessionId &&
                    String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase))
                    AllowSetForegroundWindow(process.Id);
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }
        show.Set();
    }

    public void Attach(Form form)
    {
        // A hidden form has a handle even though Process.MainWindowHandle may be zero.
        IntPtr handle = form.Handle;
        registration = ThreadPool.RegisterWaitForSingleObject(show, delegate
        {
            try
            {
                form.BeginInvoke(new MethodInvoker(delegate
                {
                    if (form.IsDisposed) return;
                    form.Show();
                    form.WindowState = FormWindowState.Normal;
                    form.Activate();
                    SetForegroundWindow(handle);
                }));
            }
            catch (InvalidOperationException) { }
        }, null, Timeout.Infinite, false);
    }

    public void Dispose()
    {
        if (registration != null) registration.Unregister(null);
        if (OwnsWindow) mutex.ReleaseMutex();
        mutex.Dispose();
        show.Dispose();
    }
}
