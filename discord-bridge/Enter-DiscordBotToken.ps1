[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'DiscordBotToken.ps1')

$configPath = Join-Path $PSScriptRoot 'config\config.json'
$tokenPath = Join-Path $PSScriptRoot 'config\token.dpapi'
$verificationPath = Join-Path $PSScriptRoot 'data\bot-token-verification.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Create the Bridge config first.' }
$config = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
$form = New-Object Windows.Forms.Form
$form.Text = 'Codex Discord Bridge - Bot Token'
$form.ClientSize = New-Object Drawing.Size(620, 240)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$label = New-Object Windows.Forms.Label
$label.Location = New-Object Drawing.Point(18, 18)
$label.Size = New-Object Drawing.Size(580, 50)
$label.Text = "Discord Developer Portal > Bot > Token`nBot ID: $($config.applicationId). Exporter/user tokens cannot be used."
$form.Controls.Add($label)
$inputBox = New-Object Windows.Forms.TextBox
$inputBox.Location = New-Object Drawing.Point(18, 76)
$inputBox.Size = New-Object Drawing.Size(580, 26)
$inputBox.UseSystemPasswordChar = $true
$form.Controls.Add($inputBox)
$statusLabel = New-Object Windows.Forms.Label
$statusLabel.Location = New-Object Drawing.Point(18, 113)
$statusLabel.Size = New-Object Drawing.Size(580, 62)
$statusLabel.Text = 'Stored only with Windows DPAPI CurrentUser. No token will be logged.'
$form.Controls.Add($statusLabel)
$save = New-Object Windows.Forms.Button
$save.Text = 'Verify and save'
$save.Location = New-Object Drawing.Point(438, 192)
$save.Size = New-Object Drawing.Size(160, 30)
$form.Controls.Add($save)
$form.AcceptButton = $save
$save.Add_Click({
    $save.Enabled = $false
    $plainToken = ConvertTo-DiscordBotTokenText -Value $inputBox.Text
    $stage = 'identity'
    $verification = $null
    try {
        if (-not $plainToken) { throw 'Enter the Bot token.' }
        $statusLabel.Text = 'Verifying Bot identity...'
        $form.Refresh()
        $verification = Test-DiscordBotIdentity -TokenText $plainToken -ApplicationId ([string]$config.applicationId)
        if (-not $verification.Valid) {
            $statusLabel.Text = "$($verification.Code) / HTTP $($verification.HttpStatus)`nExpected Bot: $($config.applicationId) / Actual Bot: $($verification.BotId)"
            $save.Enabled = $true
            return
        }
        $stage = 'save'
        Write-DiscordProtectedBotToken -TokenText $plainToken -TokenPath $tokenPath
        $inputBox.Clear()
        $form.DialogResult = [Windows.Forms.DialogResult]::OK
        $form.Close()
    }
    catch {
        # Exception bodies can contain request details; never display or log them.
        $safeCode = if ($stage -eq 'save') { 'SAVE_FAILED' } else { 'LOCAL_CHECK_FAILED' }
        $verification = [pscustomobject]@{ Valid = $false; Code = $safeCode; HttpStatus = $null;
            BotId = $null; ErrorType = $_.Exception.GetType().FullName }
        $statusLabel.Text = "$safeCode / $($verification.ErrorType)`nThe token was not logged. Retry or report this code."
        $save.Enabled = $true
    }
    finally {
        if ($verification) {
            try {
                New-Item -ItemType Directory -Path (Split-Path -Parent $verificationPath) -Force | Out-Null
                $record = @{ at = [DateTimeOffset]::UtcNow.ToString('o'); stage = $stage;
                    valid = $verification.Valid; code = $verification.Code; httpStatus = $verification.HttpStatus;
                    botId = $verification.BotId; expectedBotId = [string]$config.applicationId;
                    errorType = $verification.ErrorType }
                [IO.File]::WriteAllText($verificationPath, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
            } catch { }
        }
        $plainToken = $null
    }
})
$form.Add_Shown({ $inputBox.Focus() })
$result = $form.ShowDialog()
$inputBox.Clear()
$form.Dispose()
Write-Output ([pscustomobject]@{ Saved = $result -eq [Windows.Forms.DialogResult]::OK; Protection = 'DPAPI CurrentUser' })
