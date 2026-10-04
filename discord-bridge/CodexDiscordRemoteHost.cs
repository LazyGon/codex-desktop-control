using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Codex Discord Remote")]
[assembly: AssemblyDescription("Private Discord control surface for Codex Desktop")]
[assembly: AssemblyProduct("Codex Desktop Control")]
[assembly: AssemblyCompany("Codex Desktop Control")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class CodexDiscordRemoteBootstrap
{
    public static ProcessStartInfo CreateSharedLauncherStartInfo(string root)
    {
        string configPath = Path.Combine(root, "config", "config.json");
        if (!File.Exists(configPath))
            return null;

        var serializer = new JavaScriptSerializer();
        var config = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
        object enabledValue;
        if (!config.TryGetValue("autoStartSharedDesktop", out enabledValue) ||
            !(enabledValue is bool) || !(bool)enabledValue)
            return null;

        object launcherValue;
        if (!config.TryGetValue("sharedLauncherPath", out launcherValue))
            return null;
        string launcherPath = launcherValue as string;
        if (String.IsNullOrWhiteSpace(launcherPath))
            return null;
        if (!Path.IsPathRooted(launcherPath))
            launcherPath = Path.Combine(root, launcherPath);
        launcherPath = Path.GetFullPath(launcherPath);
        if (!File.Exists(launcherPath))
            return null;

        var startInfo = new ProcessStartInfo();
        startInfo.FileName = launcherPath;
        startInfo.Arguments = String.Empty;
        startInfo.WorkingDirectory = Path.GetDirectoryName(launcherPath);
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = false;
        startInfo.WindowStyle = ProcessWindowStyle.Normal;
        return startInfo;
    }
}

internal static class CodexDiscordRemoteRestartPolicy
{
    public const int MaximumAttempts = 10;
    public const int RetryDelayMilliseconds = 60000;
    public const int StableRunMilliseconds = 60000;

    public static bool ShouldRestart(int exitCode, int attemptsStarted)
    {
        return exitCode != 0 && attemptsStarted < MaximumAttempts;
    }
}

internal sealed class CodexDiscordRemoteContext : ApplicationContext
{
    private readonly string root;
    private readonly string startScript;
    private readonly NotifyIcon notifyIcon;
    private readonly Timer processTimer;
    private Process bridgeProcess;
    private DateTime bridgeStartedAtUtc;
    private int restartAttempts;

    public int BridgeExitCode { get; private set; }

    public CodexDiscordRemoteContext()
    {
        root = AppDomain.CurrentDomain.BaseDirectory;
        startScript = Path.Combine(root, "Start-DiscordBridge.ps1");
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

        StartSharedDesktopIfConfigured();
        bridgeProcess = StartPowerShell(startScript, true);
        bridgeStartedAtUtc = DateTime.UtcNow;

        processTimer = new Timer();
        processTimer.Interval = 500;
        processTimer.Tick += CheckBridgeProcess;
        processTimer.Start();
    }

    private void StartSharedDesktopIfConfigured()
    {
        try
        {
            ProcessStartInfo startInfo = CodexDiscordRemoteBootstrap.CreateSharedLauncherStartInfo(root);
            if (startInfo == null)
                return;
            Process launcherProcess = Process.Start(startInfo);
            if (launcherProcess != null)
                launcherProcess.Dispose();
        }
        catch
        {
            // Keep the Bridge available; launcher retries belong to the progress window.
        }
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
        if (String.Equals(scriptPath, startScript, StringComparison.OrdinalIgnoreCase))
            startInfo.EnvironmentVariables["CODEX_SHARED_STARTUP_MANAGED"] = "1";

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

    private void CheckBridgeProcess(object sender, EventArgs eventArgs)
    {
        if (bridgeProcess == null)
            return;

        if (!bridgeProcess.HasExited)
        {
            if (restartAttempts > 0 &&
                (DateTime.UtcNow - bridgeStartedAtUtc).TotalMilliseconds >=
                    CodexDiscordRemoteRestartPolicy.StableRunMilliseconds)
                restartAttempts = 0;
            return;
        }

        BridgeExitCode = bridgeProcess.ExitCode;
        bridgeProcess.Dispose();
        bridgeProcess = null;

        if (!CodexDiscordRemoteRestartPolicy.ShouldRestart(BridgeExitCode, restartAttempts))
        {
            processTimer.Stop();
            ExitThread();
            return;
        }

        ScheduleBridgeRestart();
    }

    private void ScheduleBridgeRestart()
    {
        restartAttempts++;
        processTimer.Stop();
        processTimer.Tick -= CheckBridgeProcess;
        processTimer.Tick -= RestartBridgeProcess;
        processTimer.Interval = CodexDiscordRemoteRestartPolicy.RetryDelayMilliseconds;
        processTimer.Tick += RestartBridgeProcess;
        processTimer.Start();
    }

    private void RestartBridgeProcess(object sender, EventArgs eventArgs)
    {
        processTimer.Stop();
        processTimer.Tick -= RestartBridgeProcess;

        try
        {
            bridgeProcess = StartPowerShell(startScript, true);
            bridgeStartedAtUtc = DateTime.UtcNow;
            processTimer.Interval = 500;
            processTimer.Tick += CheckBridgeProcess;
            processTimer.Start();
        }
        catch
        {
            BridgeExitCode = 1;
            if (CodexDiscordRemoteRestartPolicy.ShouldRestart(BridgeExitCode, restartAttempts))
                ScheduleBridgeRestart();
            else
                ExitThread();
        }
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
