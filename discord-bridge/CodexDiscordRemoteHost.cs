using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Codex Discord Remote")]
[assembly: AssemblyDescription("Private Discord control surface for Codex Desktop")]
[assembly: AssemblyProduct("Codex Desktop Control")]
[assembly: AssemblyCompany("Codex Desktop Control")]
[assembly: AssemblyVersion("1.0.0.0")]

internal sealed class CodexDiscordRemoteContext : ApplicationContext
{
    private readonly string root;
    private readonly NotifyIcon notifyIcon;
    private readonly Timer processTimer;
    private Process bridgeProcess;

    public int BridgeExitCode { get; private set; }

    public CodexDiscordRemoteContext()
    {
        root = AppDomain.CurrentDomain.BaseDirectory;
        string startScript = Path.Combine(root, "Start-DiscordBridge.ps1");
        if (!File.Exists(startScript))
            throw new FileNotFoundException("The Bridge start script was not found.", startScript);

        var menu = new ContextMenuStrip();
        var identityItem = new ToolStripMenuItem("Codex Discord Remote");
        identityItem.Enabled = false;
        menu.Items.Add(identityItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Show status", null, delegate { ShowStatus(); });
        menu.Items.Add("Stop safely...", null, delegate { RequestGracefulStop(); });

        notifyIcon = new NotifyIcon();
        notifyIcon.Icon = SystemIcons.Shield;
        notifyIcon.Text = "Codex Discord Remote";
        notifyIcon.ContextMenuStrip = menu;
        notifyIcon.Visible = true;
        notifyIcon.DoubleClick += delegate { ShowStatus(); };

        bridgeProcess = StartPowerShell(startScript, true);

        processTimer = new Timer();
        processTimer.Interval = 500;
        processTimer.Tick += delegate { CheckBridgeProcess(); };
        processTimer.Start();
    }

    private static string PowerShellPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");
    }

    private Process StartPowerShell(string scriptPath, bool hidden)
    {
        var startInfo = new ProcessStartInfo();
        startInfo.FileName = PowerShellPath();
        startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
            (hidden ? "-WindowStyle Hidden " : "") +
            "-File \"" + scriptPath.Replace("\"", "\\\"") + "\"";
        startInfo.WorkingDirectory = root;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = hidden;
        startInfo.WindowStyle = hidden ? ProcessWindowStyle.Hidden : ProcessWindowStyle.Normal;

        var process = Process.Start(startInfo);
        if (process == null)
            throw new InvalidOperationException("Unable to start the Bridge process.");
        return process;
    }

    private void ShowStatus()
    {
        string statusScript = Path.Combine(root, "Get-DiscordBridgeStatus.ps1");
        if (!File.Exists(statusScript))
        {
            MessageBox.Show(
                "The Bridge status script was not found.",
                "Codex Discord Remote",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var startInfo = new ProcessStartInfo();
        startInfo.FileName = PowerShellPath();
        startInfo.Arguments = "-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File \"" +
            statusScript.Replace("\"", "\\\"") + "\"";
        startInfo.WorkingDirectory = root;
        startInfo.UseShellExecute = true;
        Process.Start(startInfo);
    }

    private void RequestGracefulStop()
    {
        var result = MessageBox.Show(
            "Stop Codex Discord Remote gracefully?\n\nCodex Desktop and the shared app-server will remain running.",
            "Codex Discord Remote",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (result != DialogResult.Yes)
            return;

        string stopScript = Path.Combine(root, "Stop-DiscordBridge.ps1");
        if (!File.Exists(stopScript))
        {
            MessageBox.Show(
                "The Bridge stop script was not found.",
                "Codex Discord Remote",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        StartPowerShell(stopScript, true);
        notifyIcon.ShowBalloonTip(
            3000,
            "Codex Discord Remote",
            "Graceful stop requested.",
            ToolTipIcon.Info);
    }

    private void CheckBridgeProcess()
    {
        if (bridgeProcess == null || !bridgeProcess.HasExited)
            return;

        processTimer.Stop();
        BridgeExitCode = bridgeProcess.ExitCode;
        ExitThread();
    }

    protected override void ExitThreadCore()
    {
        processTimer.Stop();
        notifyIcon.Visible = false;
        notifyIcon.Dispose();
        if (bridgeProcess != null)
            bridgeProcess.Dispose();
        base.ExitThreadCore();
    }
}

internal static class CodexDiscordRemoteHost
{
    [STAThread]
    private static int Main()
    {
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var context = new CodexDiscordRemoteContext();
            Application.Run(context);
            return context.BridgeExitCode;
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                exception.Message,
                "Codex Discord Remote",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}
