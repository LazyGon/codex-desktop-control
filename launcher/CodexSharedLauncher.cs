using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class CodexSharedLauncher
{
    internal static string FindOnPath(
        string fileName,
        string pathValue,
        Func<string, bool> fileExists)
    {
        foreach (string rawDirectory in pathValue.Split(Path.PathSeparator))
        {
            string directory = rawDirectory.Trim().Trim('"');
            if (directory.Length == 0)
                continue;

            try
            {
                string candidate = Path.Combine(directory, fileName);
                if (fileExists(candidate))
                    return candidate;
            }
            catch (ArgumentException)
            {
                // Ignore malformed PATH entries and continue through the finite list.
            }
        }

        return null;
    }

    internal static string ResolvePowerShell(
        string pathValue,
        string programFilesDirectory,
        string systemDirectory,
        Func<string, bool> fileExists)
    {
        string[] candidates = new[]
        {
            FindOnPath("pwsh.exe", pathValue, fileExists),
            Path.Combine(
                programFilesDirectory,
                "PowerShell",
                "7",
                "pwsh.exe"),
            FindOnPath("powershell.exe", pathValue, fileExists),
            Path.Combine(
                systemDirectory,
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe")
        };

        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrEmpty(candidate) && fileExists(candidate))
                return candidate;
        }

        throw new FileNotFoundException(
            "Neither PowerShell 7 nor Windows PowerShell was found.");
    }

    private static string ResolvePowerShell()
    {
        return ResolvePowerShell(
            Environment.GetEnvironmentVariable("PATH") ?? string.Empty,
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            File.Exists);
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            bool noDialogs = args.Length == 1 &&
                String.Equals(args[0], "--no-dialogs", StringComparison.OrdinalIgnoreCase);
            if (args.Length > 0 && !noDialogs)
                throw new ArgumentException("The shared launcher received an unsupported argument.");

            string launcherRoot = AppDomain.CurrentDomain.BaseDirectory;
            string scriptPath = Path.Combine(launcherRoot, "Start-CodexShared.ps1");
            string powerShellPath = ResolvePowerShell();

            if (!File.Exists(scriptPath))
                throw new FileNotFoundException("The launcher script was not found.", scriptPath);

            var startInfo = new ProcessStartInfo
            {
                FileName = powerShellPath,
                Arguments = "-NoLogo -NoProfile -NonInteractive " +
                    "-WindowStyle Hidden -File \"" + scriptPath.Replace("\"", "\\\"") + "\"" +
                    (noDialogs ? " -NoDialogs" : String.Empty),
                WorkingDirectory = launcherRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            startInfo.EnvironmentVariables.Remove("PSExecutionPolicyPreference");

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
