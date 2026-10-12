[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'TypeSafeEnvironment.ps1')

$statusPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'state\typesafe\credential-status.json'
$uiStartedAt = [DateTimeOffset]::UtcNow.ToString('o')
$uiState = @{ Saved = $false; Failed = $false }

function Write-TypeSafeInputStatus {
    param([string]$Phase, [string]$ErrorType = $null)
    $record = [ordered]@{
        phase = $Phase
        saved = $uiState.Saved
        pid = $PID
        startedAt = $uiStartedAt
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        environmentVariable = 'TYPESAFE_API_KEY'
        environmentTarget = 'User'
        storage = 'Windows user environment (plaintext registry)'
        apiValidated = $false
        errorType = $ErrorType
    }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $statusPath)) | Out-Null
    $temporary = "$statusPath.$PID.tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($statusPath)) { [IO.File]::Replace($temporary, $statusPath, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $statusPath) }
    }
    finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

$form = [Windows.Forms.Form]::new()
$form.Text = 'TypeSafe - API Key Setup'
$form.Font = [Drawing.Font]::new('Yu Gothic UI', 10)
$form.ClientSize = [Drawing.Size]::new(640, 325)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = [Windows.Forms.Label]::new()
$label.Location = [Drawing.Point]::new(20, 18)
$label.Size = [Drawing.Size]::new(600, 52)
$label.Text = "TypeSafe の API キーを貼り付けてください。`n公式 SDK が読む TYPESAFE_API_KEY 環境変数に設定します。"
$form.Controls.Add($label)

$consoleLink = [Windows.Forms.LinkLabel]::new()
$consoleLink.Location = [Drawing.Point]::new(20, 74)
$consoleLink.Size = [Drawing.Size]::new(600, 26)
$consoleLink.Text = 'キーの発行先: https://console.typesafe.ai'
$consoleLink.Add_LinkClicked({
    $openLink = [Diagnostics.ProcessStartInfo]::new('https://console.typesafe.ai')
    $openLink.UseShellExecute = $true
    [Diagnostics.Process]::Start($openLink) | Out-Null
})
$form.Controls.Add($consoleLink)

$inputBox = [Windows.Forms.TextBox]::new()
$inputBox.Location = [Drawing.Point]::new(20, 107)
$inputBox.Size = [Drawing.Size]::new(600, 28)
$inputBox.UseSystemPasswordChar = $true
$form.Controls.Add($inputBox)

$statusLabel = [Windows.Forms.Label]::new()
$statusLabel.Location = [Drawing.Point]::new(20, 149)
$statusLabel.Size = [Drawing.Size]::new(600, 100)
$statusLabel.Text = "保存先: この Windows ユーザーの環境変数（永続・レジストリ平文）。`n保存後に起動したプロセスで利用できます。起動済みのターミナルは再読込が必要です。`n保存時の API 通信・課金はありません。接続確認は未実施です。"
$form.Controls.Add($statusLabel)

$cancel = [Windows.Forms.Button]::new()
$cancel.Location = [Drawing.Point]::new(300, 271)
$cancel.Size = [Drawing.Size]::new(150, 34)
$cancel.Text = 'キャンセル'
$cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)
$form.CancelButton = $cancel

$save = [Windows.Forms.Button]::new()
$save.Location = [Drawing.Point]::new(465, 271)
$save.Size = [Drawing.Size]::new(155, 34)
$save.Text = '環境変数に保存'
$form.Controls.Add($save)
$form.AcceptButton = $save
$save.Add_Click({
    if ([string]::IsNullOrWhiteSpace($inputBox.Text)) {
        $statusLabel.Text = 'API キーを入力してください。'
        return
    }
    $save.Enabled = $false
    try {
        Set-TypeSafeApiKeyEnvironment -ApiKeyText $inputBox.Text -Target User
        $uiState.Saved = $true
        $inputBox.Clear()
        try { Write-TypeSafeInputStatus -Phase 'saved' } catch { }
        $form.DialogResult = [Windows.Forms.DialogResult]::OK
        $form.Close()
    }
    catch {
        # Never display exception messages, request data, or the entered key.
        $uiState.Failed = $true
        $safeType = $_.Exception.GetType().FullName
        $statusLabel.Text = "SAVE_FAILED / $safeType`nキーはログに出していません。入力形式または環境変数の保存権限を確認してください。"
        try { Write-TypeSafeInputStatus -Phase 'save-failed' -ErrorType $safeType } catch { }
        $save.Enabled = $true
    }
})
$form.Add_Shown({
    try { Write-TypeSafeInputStatus -Phase 'awaiting-input' } catch { }
    $form.Activate()
    $inputBox.Focus() | Out-Null
    $form.TopMost = $false
})
try { $null = $form.ShowDialog() }
finally {
    $inputBox.Clear()
    $form.Dispose()
    if (-not $uiState.Saved) {
        $phase = if ($uiState.Failed) { 'closed-after-failure' } else { 'cancelled' }
        try { Write-TypeSafeInputStatus -Phase $phase } catch { }
    }
}
