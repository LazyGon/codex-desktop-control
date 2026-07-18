using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class CodexSharedLauncher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string launcherRoot = AppDomain.CurrentDomain.BaseDirectory;
            string scriptPath = Path.Combine(launcherRoot, "Start-CodexShared.ps1");
            string powerShellPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe");

            if (!File.Exists(scriptPath))
                throw new FileNotFoundException("The launcher script was not found.", scriptPath);

            var startInfo = new ProcessStartInfo
            {
                FileName = powerShellPath,
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
                    "-WindowStyle Hidden -File \"" + scriptPath.Replace("\"", "\\\"") + "\"",
                WorkingDirectory = launcherRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            Process.Start(startInfo);
            return 0;
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                exception.Message,
                "Codex Shared Server",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}
