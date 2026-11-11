using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class SharedRuntimeObservation
{
    public bool ServerReady { get; set; }
    public bool DesktopVerified { get; set; }
    public bool DesktopAlive { get; set; }
    public bool SupervisorAlive { get; set; }
    public bool BridgeConfigured { get; set; }
    public bool BridgeAlive { get; set; }
    public bool DiscordReady { get; set; }
    public bool BridgeReady { get; set; }
    public string BridgeStatus { get; set; }
    public string Endpoint { get; set; }
}

internal sealed class SharedLaunchProgressForm : Form
{
    private readonly string statePath;
    private readonly string bridgeRoot;
    private readonly string launcherRoot;
    private string progressPath;
    private readonly string baseArguments;
    private readonly ProcessStartInfo startInfo;
    private readonly Stopwatch elapsed = new Stopwatch();
    private readonly Stopwatch completionDisplay = new Stopwatch();
    private readonly DataGridView statusGrid = new DataGridView();
    private readonly ProgressBar progressBar = new ProgressBar();
    private readonly Label summaryLabel = new Label();
    private readonly Button closeButton = new Button();
    private readonly Button logButton = new Button();
    private readonly TextBox detailBox = new TextBox();
    private readonly Timer timer = new Timer();
    private Process launcherProcess;
    private int verifiedTicks;
    private string logPath;
    private DateTime? bridgeWaitStarted;
    private bool closingRequested;
    private bool wasReady;
    private bool monitorExisting;
    private Process componentStop;
    private string componentStopResult;
    private readonly List<Button> stopButtons = new List<Button>();

    public int ResultCode { get; private set; }

    public SharedLaunchProgressForm(string launcherRoot, ProcessStartInfo processStartInfo)
    {
        this.launcherRoot = launcherRoot;
        statePath = Path.Combine(launcherRoot, "state", "current.json");
        bridgeRoot = Path.Combine(Directory.GetParent(launcherRoot.TrimEnd(Path.DirectorySeparatorChar)).FullName, "discord-bridge");
        Directory.CreateDirectory(Path.Combine(launcherRoot, "state"));
        startInfo = processStartInfo;
        baseArguments = startInfo.Arguments + " -InteractiveWorker";
        ResultCode = 0;

        Text = "Codex 共有起動状況";
        ClientSize = new Size(620, 330);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;
        ShowInTaskbar = true;
        Font = new Font("Segoe UI", 9F);

        summaryLabel.AutoSize = false;
        summaryLabel.Location = new Point(14, 12);
        summaryLabel.Size = new Size(592, 42);
        summaryLabel.Text = "Codex の共有起動を準備しています…";
        summaryLabel.TextAlign = ContentAlignment.MiddleLeft;
        Controls.Add(summaryLabel);

        statusGrid.Location = new Point(14, 60);
        statusGrid.Size = new Size(592, 122);
        statusGrid.AllowUserToAddRows = false;
        statusGrid.AllowUserToDeleteRows = false;
        statusGrid.AllowUserToResizeRows = false;
        statusGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        statusGrid.BackgroundColor = SystemColors.Window;
        statusGrid.BorderStyle = BorderStyle.FixedSingle;
        statusGrid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
        statusGrid.ColumnHeadersHeight = 25;
        statusGrid.MultiSelect = false;
        statusGrid.ReadOnly = true;
        statusGrid.RowHeadersVisible = false;
        statusGrid.ScrollBars = ScrollBars.None;
        statusGrid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        statusGrid.TabStop = false;
        statusGrid.Columns.Add("item", "項目");
        statusGrid.Columns.Add("status", "状態");
        var retryColumn = new DataGridViewButtonColumn();
        retryColumn.Name = "retry";
        retryColumn.HeaderText = "操作";
        statusGrid.Columns.Add(retryColumn);
        statusGrid.Columns[0].FillWeight = 30;
        statusGrid.Columns[1].FillWeight = 52;
        statusGrid.Columns[2].FillWeight = 18;
        statusGrid.Rows.Add("共有 App Server", "確認中…", "再試行");
        statusGrid.Rows.Add("Desktop", "接続待ち…", "再試行");
        statusGrid.Rows.Add("Discord Bridge", "確認中…", "再試行");
        statusGrid.Rows.Add("経過時間", "0 秒", "");
        statusGrid.CellContentClick += RetryStep;
        Controls.Add(statusGrid);

        progressBar.Location = new Point(14, 195);
        progressBar.Size = new Size(592, 20);
        progressBar.Style = ProgressBarStyle.Marquee;
        progressBar.MarqueeAnimationSpeed = 30;
        Controls.Add(progressBar);

        closeButton.Location = new Point(526, 226);
        closeButton.Size = new Size(80, 26);
        closeButton.Text = "閉じる";
        closeButton.Visible = true;
        closeButton.Click += delegate { Close(); };
        Controls.Add(closeButton);

        logButton.Location = new Point(420, 226);
        logButton.Size = new Size(100, 26);
        logButton.Text = "ログを開く";
        logButton.Enabled = false;
        logButton.Click += delegate
        {
            if (!String.IsNullOrWhiteSpace(logPath) && File.Exists(logPath))
                Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true });
        };
        Controls.Add(logButton);

        detailBox.Location = new Point(14, 334);
        detailBox.Size = new Size(592, 110);
        detailBox.Multiline = true;
        detailBox.ReadOnly = true;
        detailBox.ScrollBars = ScrollBars.Vertical;
        detailBox.Visible = false;
        Controls.Add(detailBox);

        var serverOnly = new Button { Text = "サーバーのみ起動", Location = new Point(14, 226), Size = new Size(150, 26) };
        serverOnly.Click += delegate
        {
            if ((launcherProcess == null || launcherProcess.HasExited) && componentStop == null)
                StartOperation("Shared");
        };
        Controls.Add(serverOnly);
        string[] components = { "Shared", "Desktop", "Bridge" };
        string[] componentLabels = { "AppServer 強制終了", "Desktop 強制終了", "Bridge 強制終了" };
        for (int index = 0; index < components.Length; index++)
        {
            string component = components[index];
            var button = new Button { Text = componentLabels[index], Location = new Point(14 + index * 200, 263), Size = new Size(192, 26) };
            button.Click += delegate { StopComponent(component); };
            stopButtons.Add(button);
            Controls.Add(button);
        }
        var note = new Label();
        note.AutoSize = false;
        note.Location = new Point(14, 300);
        note.Size = new Size(592, 20);
        note.ForeColor = SystemColors.GrayText;
        note.Text = "強制終了すると、実行中の処理も終了します。";
        Controls.Add(note);

        timer.Interval = 500;
        timer.Tick += ObserveStartup;
        Shown += BeginLaunch;
        FormClosing += RequestClose;
        FormClosed += Cleanup;
    }

    private void BeginLaunch(object sender, EventArgs eventArgs)
    {
        SharedRuntimeObservation existing = ReadObservation(statePath);
        ReadBridgeObservation(bridgeRoot, existing);
        if (existing.ServerReady || existing.DesktopAlive || existing.BridgeAlive || existing.SupervisorAlive)
        {
            monitorExisting = true;
            timer.Start();
            ObserveStartup(this, EventArgs.Empty);
            return;
        }
        StartOperation("All");
    }

    private void RetryStep(object sender, DataGridViewCellEventArgs eventArgs)
    {
        if (eventArgs.ColumnIndex != 2 || eventArgs.RowIndex < 0 || eventArgs.RowIndex > 2 ||
            closingRequested || componentStop != null || (launcherProcess != null && !launcherProcess.HasExited))
            return;
        StartOperation(new[] { "Shared", "Desktop", "Bridge" }[eventArgs.RowIndex]);
    }

    private void StartOperation(string step)
    {
        try
        {
            if (launcherProcess != null) launcherProcess.Dispose();
            progressPath = Path.Combine(Path.GetDirectoryName(statePath), "startup-" + Guid.NewGuid().ToString("N") + ".json");
            startInfo.Arguments = baseArguments + " -RetryStep " + step + " -ProgressPath \"" + progressPath + "\"";
            if (step == "Shared") startInfo.Arguments += " -ServerOnly";
            detailBox.Visible = false;
            detailBox.Text = String.Empty;
            ClientSize = new Size(620, 330);
            monitorExisting = false;
            summaryLabel.ForeColor = SystemColors.ControlText;
            summaryLabel.Text = "指定された起動操作を実行しています…";
            progressBar.Style = ProgressBarStyle.Marquee;
            statusGrid.Enabled = false;
            ResultCode = 0;
            wasReady = false;
            verifiedTicks = 0;
            bridgeWaitStarted = null;
            completionDisplay.Reset();
            elapsed.Restart();
            launcherProcess = Process.Start(startInfo);
            if (launcherProcess == null)
                throw new InvalidOperationException("共有ランチャーを開始できませんでした。");
            timer.Start();
            ObserveStartup(this, EventArgs.Empty);
        }
        catch (Exception exception)
        {
            ShowFailure(exception.Message);
        }
    }

    private void ObserveStartup(object sender, EventArgs eventArgs)
    {
        ObserveComponentStop();
        statusGrid.Enabled = launcherProcess == null || launcherProcess.HasExited;
        if (closingRequested)
        {
            summaryLabel.Text = "起動操作の中止を待っています…";
            if (launcherProcess == null || launcherProcess.HasExited)
            {
                StopElapsed();
                Close();
            }
            return;
        }
        statusGrid.Rows[3].Cells[1].Value =
            Math.Max(0, (int)elapsed.Elapsed.TotalSeconds).ToString(CultureInfo.InvariantCulture) + " 秒";

        SharedRuntimeObservation observation = ReadObservation(statePath);
        ReadBridgeObservation(bridgeRoot, observation);
        statusGrid.Rows[0].Cells[1].Value = observation.ServerReady ? "起動済み" : "確認中…";
        statusGrid.Rows[1].Cells[1].Value = observation.DesktopVerified ? "接続済み" : "接続待ち…";
        statusGrid.Rows[2].Cells[1].Value = observation.BridgeStatus;

        if (monitorExisting)
        {
            summaryLabel.Text = componentStop != null ? "終了処理中…" : "起動中のアプリ";
            statusGrid.Rows[0].Cells[1].Value = observation.ServerReady ? "起動済み" : "未接続";
            statusGrid.Rows[1].Cells[1].Value = observation.DesktopVerified ? "接続済み" : observation.DesktopAlive ? "起動済み・共有未接続" : "未起動";
            progressBar.Style = ProgressBarStyle.Blocks;
            progressBar.Value = observation.ServerReady ? 100 : 0;
            return;
        }

        Dictionary<string, object> receipt = ReadProgress(progressPath, launcherProcess.Id);
        string phase = GetString(receipt, "phase");
        if (receipt != null)
        {
            summaryLabel.Text = GetString(receipt, "summary");
            logPath = GetString(receipt, "logPath");
            logButton.Enabled = File.Exists(logPath);
            if (!observation.ServerReady)
                statusGrid.Rows[0].Cells[1].Value = GetString(receipt, "serverStatus");
            if (!observation.DesktopVerified)
                statusGrid.Rows[1].Cells[1].Value = GetString(receipt, "desktopStatus");
        }

        if (phase == "failed")
        {
            string failedStep = GetString(receipt, "step");
            int failedRow = failedStep == "Bridge" ? 2 : failedStep == "Desktop" ? 1 : 0;
            statusGrid.Rows[failedRow].Cells[1].Value = "失敗";
            if (failedRow == 0 && !observation.DesktopVerified)
                statusGrid.Rows[1].Cells[1].Value = "未完了（共有起動に失敗）";
            if (failedRow != 2 && !observation.BridgeReady)
                statusGrid.Rows[2].Cells[1].Value = observation.DiscordReady ? "Discord 接続済み／共有失敗" : "未完了（起動失敗）";
            ShowFailure(GetString(receipt, "summary"), GetString(receipt, "detail"));
            return;
        }
        if (phase == "cancelled")
        {
            FinishSkipped("起動操作を中止しました。", "正常稼働中のアプリは維持しています。");
            return;
        }
        if (phase == "skipped")
        {
            statusGrid.Rows[0].Cells[1].Value = GetString(receipt, "serverStatus");
            statusGrid.Rows[1].Cells[1].Value = GetString(receipt, "desktopStatus");
            if (!observation.DesktopVerified)
            {
                if (observation.BridgeConfigured && !observation.BridgeReady)
                    statusGrid.Rows[2].Cells[1].Value = observation.DiscordReady
                        ? "Discord 接続済み／共有未接続" : "未接続（起動スキップ）";
                FinishSkipped(GetString(receipt, "summary"), GetString(receipt, "detail"));
                return;
            }
        }

        bool serverOnlyReady = receipt != null && receipt.ContainsKey("serverOnly") &&
            receipt["serverOnly"] is bool && (bool)receipt["serverOnly"] && observation.ServerReady;
        if ((observation.DesktopVerified || serverOnlyReady) && (phase == "ready" || phase == "skipped" || phase == "bridge-ready"))
        {
            if (observation.BridgeConfigured && !observation.BridgeReady)
            {
                if (!bridgeWaitStarted.HasValue) bridgeWaitStarted = DateTime.UtcNow;
                summaryLabel.Text = "Desktop は共有接続済みです。Discord Bridge の接続を待っています。";
                if (wasReady || (DateTime.UtcNow - bridgeWaitStarted.Value).TotalSeconds >= 300)
                {
                    statusGrid.Rows[2].Cells[1].Value = "接続失敗";
                    ShowFailure("Discord Bridge の接続を完了できませんでした。",
                        observation.BridgeStatus + "。5 分以内に Discord と共有 App Server の両方へ接続できませんでした。");
                }
                return;
            }
            verifiedTicks++;
            summaryLabel.Text = serverOnlyReady ? "共有 AppServer 起動済み" : phase == "skipped"
                ? "すでに起動済みのためスキップしました。接続は正常です。"
                : "共有 App Server・Desktop・Discord Bridge の確認が完了しました。";
            summaryLabel.ForeColor = Color.DarkGreen;
            progressBar.Style = ProgressBarStyle.Blocks;
            progressBar.Value = 100;
            wasReady = true;
            FinishSuccessfulOperation();
            return;
        }

        verifiedTicks = 0;
        if (launcherProcess != null && launcherProcess.HasExited)
        {
            if (wasReady || phase == "ready" || phase == "bridge-ready")
            {
                statusGrid.Rows[0].Cells[1].Value = observation.ServerReady ? "起動済み" : "接続失敗";
                statusGrid.Rows[1].Cells[1].Value = observation.DesktopVerified ? "接続済み" : "共有接続失敗";
                ShowFailure("共有接続を確認できません。", "共有 App Server または Desktop の接続が途切れました。失敗した行の再試行を選んでください。");
                return;
            }
            ShowFailure("今回の共有起動が終了しました。",
                "終了コード: " + launcherProcess.ExitCode.ToString(CultureInfo.InvariantCulture) +
                "。今回の起動結果を取得できないか、共有接続が未完了です。結果ファイル: " + progressPath);
        }
    }

    private void StopComponent(string component)
    {
        if (closingRequested || componentStop != null) return;
        try
        {
            if (launcherProcess != null && !launcherProcess.HasExited)
                File.WriteAllText(progressPath + ".cancel", "component stop requested");
            string operation = Guid.NewGuid().ToString();
            componentStopResult = Path.Combine(launcherRoot, "state", "component-stop-" + operation + ".json");
            var info = new ProcessStartInfo
            {
                FileName = startInfo.FileName,
                Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File \"" +
                    Path.Combine(launcherRoot, "Stop-CodexComponent.ps1") + "\" -Force -Component " + component +
                    " -OperationId " + operation + " -ResultPath \"" + componentStopResult + "\"",
                WorkingDirectory = launcherRoot, UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            info.EnvironmentVariables.Remove("PSExecutionPolicyPreference");
            componentStop = Process.Start(info);
            if (componentStop == null) throw new InvalidOperationException("終了処理を開始できませんでした。");
            foreach (Button button in stopButtons) button.Enabled = false;
            timer.Start();
        }
        catch (Exception error) { ShowFailure("終了処理を開始できませんでした。", error.Message); }
    }

    private void ObserveComponentStop()
    {
        if (componentStop == null || !componentStop.HasExited) return;
        int exitCode = componentStop.ExitCode;
        componentStop.Dispose();
        componentStop = null;
        monitorExisting = true;
        foreach (Button button in stopButtons) button.Enabled = true;
        try
        {
            var result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                ReadReplaceableStateFile(componentStopResult));
            if (exitCode != 0 || GetString(result, "phase") != "completed")
                ShowDetail(GetString(result, "error") + Environment.NewLine + componentStopResult);
        }
        catch (Exception error) { ShowDetail(error.Message + Environment.NewLine + componentStopResult); }
    }

    private void RequestClose(object sender, FormClosingEventArgs eventArgs)
    {
        if (launcherProcess != null && !launcherProcess.HasExited)
        {
            File.WriteAllText(progressPath + ".cancel", "cancel requested");
            closingRequested = true;
            eventArgs.Cancel = true;
            statusGrid.Enabled = false;
            closeButton.Enabled = false;
            summaryLabel.Text = "起動操作を中止しています…";
            timer.Start();
        }
    }

    internal static Dictionary<string, object> ReadProgress(string path, int expectedProcessId)
    {
        try
        {
            var value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(ReadReplaceableStateFile(path));
            object processId;
            if (value == null || !value.TryGetValue("launcherProcessId", out processId) ||
                Convert.ToInt32(processId, CultureInfo.InvariantCulture) != expectedProcessId)
                return null;
            return value;
        }
        catch { return null; }
    }

    private static string GetString(Dictionary<string, object> value, string key)
    {
        object entry;
        return value != null && value.TryGetValue(key, out entry) ? entry as string ?? String.Empty : String.Empty;
    }

    private static string ReadReplaceableStateFile(string path)
    {
        using (var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new StreamReader(stream))
            return reader.ReadToEnd();
    }

    internal static void ReadBridgeObservation(string root, SharedRuntimeObservation observation)
    {
        observation.BridgeConfigured = File.Exists(Path.Combine(root, "config", "config.json"));
        observation.BridgeStatus = observation.BridgeConfigured ? "起動・接続待ち…" : "未設定（スキップ）";
        if (!observation.BridgeConfigured) return;
        try
        {
            string dataRoot = Path.Combine(root, "data");
            var runtime = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                ReadReplaceableStateFile(Path.Combine(dataRoot, "runtime.json")));
            if (GetString(runtime, "phase") != "running" ||
                !String.Equals(Path.GetFullPath(GetString(runtime, "bridgeRoot")), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase))
                return;
            int pid = Convert.ToInt32(runtime["pid"], CultureInfo.InvariantCulture);
            int lockPid;
            if (!Int32.TryParse(ReadReplaceableStateFile(Path.Combine(dataRoot, "bridge.lock")), NumberStyles.Integer,
                CultureInfo.InvariantCulture, out lockPid) || lockPid != pid) return;
            using (Process process = Process.GetProcessById(pid))
            {
                DateTimeOffset startedAt;
                // Node may take longer to initialize than the launcher takes to start it.
                // A reused PID starts after the previous runtime record.
                if (process.HasExited || !String.Equals(process.ProcessName, "node", StringComparison.OrdinalIgnoreCase) ||
                    !DateTimeOffset.TryParse(GetString(runtime, "startedAt"), CultureInfo.InvariantCulture, DateTimeStyles.None, out startedAt) ||
                    process.StartTime.ToUniversalTime() > startedAt.UtcDateTime)
                    return;
            }
            observation.BridgeAlive = true;
            observation.DiscordReady = runtime.ContainsKey("discordReady") && runtime["discordReady"] is bool && (bool)runtime["discordReady"];
            var codex = runtime.ContainsKey("codex") ? runtime["codex"] as Dictionary<string, object> : null;
            bool connected = codex != null && codex.ContainsKey("connected") && codex["connected"] is bool && (bool)codex["connected"];
            string endpoint = GetString(codex, "endpoint");
            Uri serverUri;
            observation.BridgeReady = observation.DiscordReady && connected &&
                endpoint == observation.Endpoint && observation.ServerReady && Uri.TryCreate(endpoint, UriKind.Absolute, out serverUri) &&
                HasOwnedLoopbackTcp(new[] { pid }, serverUri.Port, true);
            observation.BridgeStatus = observation.BridgeReady ? "Discord・共有接続済み"
                : observation.DiscordReady ? "Discord 接続済み／共有待ち"
                : "起動済み／Discord 接続待ち";
        }
        catch { }
    }

    internal static SharedRuntimeObservation ReadObservation(string stateFilePath)
    {
        var result = new SharedRuntimeObservation();
        if (!File.Exists(stateFilePath))
            return result;

        try
        {
            var serializer = new JavaScriptSerializer();
            var state = serializer.Deserialize<Dictionary<string, object>>(
                ReadReplaceableStateFile(stateFilePath));

            object supervisorValue;
            DateTimeOffset recordedAt;
            if (state.TryGetValue("supervisorProcessId", out supervisorValue) &&
                DateTimeOffset.TryParse(GetString(state, "startedAt"), out recordedAt))
            {
                try
                {
                    using (var supervisor = Process.GetProcessById(Convert.ToInt32(supervisorValue, CultureInfo.InvariantCulture)))
                        result.SupervisorAlive = !supervisor.HasExited &&
                            supervisor.SessionId == Process.GetCurrentProcess().SessionId &&
                            supervisor.StartTime.ToUniversalTime() <= recordedAt.UtcDateTime;
                }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
            }

            object processValue;
            object readyUrlValue;
            object desktopValue;
            object desktopProcessIdsValue;
            object desktopExecutableValue;
            if (!state.TryGetValue("serverProcessId", out processValue) ||
                !state.TryGetValue("readyUrl", out readyUrlValue) ||
                !state.TryGetValue("desktopConnectionVerified", out desktopValue) ||
                !state.TryGetValue("desktopProcessIds", out desktopProcessIdsValue) ||
                !state.TryGetValue("desktopExecutable", out desktopExecutableValue))
                return result;

            int processId = Convert.ToInt32(processValue, CultureInfo.InvariantCulture);
            bool desktopVerified = desktopValue is bool && (bool)desktopValue;
            string readyUrl = readyUrlValue as string;
            string desktopExecutable = desktopExecutableValue as string;
            result.DesktopAlive = HasLiveDesktopProcess(desktopProcessIdsValue as IEnumerable, desktopExecutable);
            using (Process process = Process.GetProcessById(processId))
            {
                if (process.HasExited)
                    return result;
            }

            Uri readyUri;
            if (!Uri.TryCreate(readyUrl, UriKind.Absolute, out readyUri)) return result;
            result.Endpoint = "ws://127.0.0.1:" + readyUri.Port.ToString(CultureInfo.InvariantCulture);
            result.ServerReady = HasOwnedLoopbackTcp(new[] { processId }, readyUri.Port, false) && ProbeLoopbackReady(readyUrl);
            result.DesktopVerified = result.ServerReady && desktopVerified &&
                HasLiveDesktopProcess(desktopProcessIdsValue as IEnumerable, desktopExecutable) &&
                HasOwnedLoopbackTcp(desktopProcessIdsValue as IEnumerable, readyUri.Port, true);
            return result;
        }
        catch
        {
                return result;
        }
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order,
        int addressFamily, int tableClass, uint reserved);

    private static bool HasOwnedLoopbackTcp(IEnumerable processIds, int port, bool established)
    {
        if (processIds == null) return false;
        var owners = new HashSet<int>();
        foreach (object id in processIds) owners.Add(Convert.ToInt32(id, CultureInfo.InvariantCulture));
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
        if (size <= 0) return false;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (GetExtendedTcpTable(buffer, ref size, false, 2, 5, 0) != 0) return false;
            int count = Marshal.ReadInt32(buffer);
            for (int index = 0; index < count; index++)
            {
                IntPtr row = IntPtr.Add(buffer, 4 + index * 24);
                int state = Marshal.ReadInt32(row, 0);
                int address = Marshal.ReadInt32(row, established ? 12 : 4);
                int networkPort = Marshal.ReadInt32(row, established ? 16 : 8);
                int actualPort = ((networkPort & 255) << 8) | ((networkPort >> 8) & 255);
                int owner = Marshal.ReadInt32(row, 20);
                if (state == (established ? 5 : 2) && address == 0x0100007f &&
                    actualPort == port && owners.Contains(owner)) return true;
            }
            return false;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool HasLiveDesktopProcess(IEnumerable processIds, string desktopExecutable)
    {
        if (processIds == null || String.IsNullOrWhiteSpace(desktopExecutable))
            return false;

        foreach (object processIdValue in processIds)
        {
            try
            {
                int processId = Convert.ToInt32(processIdValue, CultureInfo.InvariantCulture);
                using (Process process = Process.GetProcessById(processId))
                {
                    if (!process.HasExited && process.MainModule != null &&
                        String.Equals(
                            process.MainModule.FileName,
                            desktopExecutable,
                            StringComparison.OrdinalIgnoreCase))
                        return true;
                }
            }
            catch
            {
                // A stale PID or unreadable process is not proof of a live shared Desktop.
            }
        }
        return false;
    }

    private static bool ProbeLoopbackReady(string readyUrl)
    {
        Uri uri;
        if (!Uri.TryCreate(readyUrl, UriKind.Absolute, out uri) ||
            uri.Scheme != Uri.UriSchemeHttp ||
            uri.Host != "127.0.0.1" ||
            uri.AbsolutePath != "/readyz")
            return false;

        try
        {
            var request = (HttpWebRequest)WebRequest.Create(uri);
            request.Method = "GET";
            request.Timeout = 750;
            request.ReadWriteTimeout = 750;
            request.KeepAlive = false;
            using (var response = (HttpWebResponse)request.GetResponse())
                return response.StatusCode == HttpStatusCode.OK;
        }
        catch
        {
            return false;
        }
    }

    private void ShowFailure(string message, string detail = "")
    {
        StopElapsed();
        completionDisplay.Reset();
        ResultCode = 1;
        if (launcherProcess == null || launcherProcess.HasExited) timer.Stop();
        summaryLabel.Text = message;
        summaryLabel.ForeColor = Color.DarkRed;
        progressBar.Style = ProgressBarStyle.Blocks;
        progressBar.Value = 0;
        closeButton.Visible = true;
        statusGrid.Enabled = launcherProcess == null || launcherProcess.HasExited;
        ShowDetail(detail);
    }

    private void FinishSkipped(string message, string detail)
    {
        ResultCode = 0;
        statusGrid.Enabled = launcherProcess == null || launcherProcess.HasExited;
        summaryLabel.Text = message;
        summaryLabel.ForeColor = Color.DarkGoldenrod;
        progressBar.Style = ProgressBarStyle.Blocks;
        progressBar.Value = 100;
        ShowDetail(detail);
        StopElapsed();
    }

    private void StopElapsed()
    {
        elapsed.Stop();
        statusGrid.Rows[3].Cells[1].Value =
            Math.Max(0, (int)elapsed.Elapsed.TotalSeconds).ToString(CultureInfo.InvariantCulture) + " 秒";
    }

    private void FinishSuccessfulOperation()
    {
        StopElapsed();
        if (!completionDisplay.IsRunning) completionDisplay.Start();
        // Keep the completed result visible for ten seconds and reap the finite
        // startup worker before closing, without cancelling or
        // stopping the independent runtime supervisor and its running apps.
        if (completionDisplay.Elapsed.TotalSeconds >= 10 &&
            (launcherProcess == null || launcherProcess.HasExited))
        {
            timer.Stop();
            Close();
        }
    }

    private void ShowDetail(string detail)
    {
        detailBox.Text = detail + (String.IsNullOrWhiteSpace(logPath) ? String.Empty : Environment.NewLine + Environment.NewLine + "ログ: " + logPath);
        detailBox.Visible = !String.IsNullOrWhiteSpace(detailBox.Text);
        if (detailBox.Visible) ClientSize = new Size(620, 458);
    }

    private void Cleanup(object sender, FormClosedEventArgs eventArgs)
    {
        timer.Stop();
        timer.Dispose();
        if (launcherProcess != null)
            launcherProcess.Dispose();
        if (componentStop != null) componentStop.Dispose();
    }
}

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
                    "-WindowStyle Hidden -File \"" + scriptPath.Replace("\"", "\\\"") + "\" -NoDialogs",
                WorkingDirectory = launcherRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            startInfo.EnvironmentVariables.Remove("PSExecutionPolicyPreference");

            if (noDialogs)
            {
                Process process = Process.Start(startInfo);
                if (process != null)
                    process.Dispose();
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var windowOwner = new CodexLauncherWindow(launcherRoot))
            {
                if (!windowOwner.OwnsWindow)
                {
                    windowOwner.RequestShow();
                    return 0;
                }
                using (var progressForm = new SharedLaunchProgressForm(launcherRoot, startInfo))
                {
                    windowOwner.Attach(progressForm);
                    Application.Run(progressForm);
                    return progressForm.ResultCode;
                }
            }
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
