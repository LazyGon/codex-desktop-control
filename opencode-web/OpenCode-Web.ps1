param(
    [ValidateSet('Initialize', 'Start', 'Status', 'Register', 'ShowLogin', 'Shortcuts')]
    [string]$Mode = 'Status',
    [string]$InstanceRoot = 'D:\AI\OpenCode',
    [switch]$WaitForExit,
    [string]$RemoteUrl = ''
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskName = 'OpenCode Web (Ollama)'
$description = 'OpenCode Web: local Ollama, loopback only, current user Limited.'
$binary = Join-Path $InstanceRoot 'runtime\node_modules\opencode-windows-x64\bin\opencode.exe'
$workspace = Join-Path $InstanceRoot 'projects\mobile-apps'
$config = Join-Path $InstanceRoot 'config\opencode.json'
$secretPath = Join-Path $InstanceRoot 'credentials\login.xml'
$statePath = Join-Path $InstanceRoot 'state\server.json'
$pythonw = Join-Path $env:LOCALAPPDATA 'Python\pythoncore-3.14-64\pythonw.exe'
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Get-OwnedTask {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $sid = if ($task.Principal.UserId -like 'S-1-*') { $task.Principal.UserId } else {
            ([Security.Principal.NTAccount]$task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($sid -ne $identity.User.Value -or $task.Description -ne $description) {
            throw 'An existing scheduled task has different ownership. No replacement.'
        }
    }
    return $task
}

function Get-Login {
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) { throw 'Initialize login first.' }
    $login = Import-Clixml -LiteralPath $secretPath
    if ($login -isnot [Management.Automation.PSCredential] -or $login.UserName -ne 'opencode') {
        throw 'Unexpected login identity.'
    }
    return $login
}

function Get-Server {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 4096 -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $null }
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') {
        throw 'Port 4096 is not an exclusive loopback listener.'
    }
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Listener ownership receipt is missing.' }
    $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $owner = Get-Process -Id $listeners[0].OwningProcess -ErrorAction Stop
    if ($owner.Id -ne $saved.pid -or $owner.Path -ne $binary -or
        $owner.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$saved.startedAt).ToUniversalTime().Ticks) {
        throw 'Listener process identity does not match the saved receipt.'
    }
    return $owner
}

if ($Mode -eq 'Initialize') {
    if (-not [IO.Path]::IsPathRooted($InstanceRoot)) { throw 'InstanceRoot must be absolute.' }
    foreach ($directory in @('config', 'credentials', 'state', 'projects\mobile-apps', 'data', 'cache')) {
        $null = New-Item -ItemType Directory -Path (Join-Path $InstanceRoot $directory) -Force
    }
    $secretDirectory = Split-Path -Parent $secretPath
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($identity.User)
    foreach ($sid in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            [Security.Principal.SecurityIdentifier]$sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $secretDirectory -AclObject $acl
    if (-not (Test-Path -LiteralPath $secretPath)) {
        $bytes = New-Object byte[] 24
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $password = [Convert]::ToBase64String($bytes)
        $secure = ConvertTo-SecureString -String $password -AsPlainText -Force
        $login = New-Object Management.Automation.PSCredential('opencode', $secure)
        $login | Export-Clixml -LiteralPath $secretPath -Encoding UTF8
        $password = $null
    }
    if (Test-Path -LiteralPath $config) { throw 'Configuration already exists; preserve it and reconcile manually.' }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'opencode.template.json') -Destination $config
    [ordered]@{ initialized = $true; instanceRoot = $InstanceRoot; workspace = $workspace } | ConvertTo-Json
    exit 0
}

if ($Mode -eq 'ShowLogin') {
    $login = Get-Login
    Add-Type -AssemblyName System.Windows.Forms
    $form = New-Object Windows.Forms.Form
    $form.Text = 'OpenCode Login'
    $form.Width = 520
    $form.Height = 190
    $form.StartPosition = 'CenterScreen'
    $label = New-Object Windows.Forms.Label
    $label.Text = 'opencode'
    $label.SetBounds(20, 20, 460, 25)
    $field = New-Object Windows.Forms.TextBox
    $field.Text = $login.GetNetworkCredential().Password
    $field.ReadOnly = $true
    $field.UseSystemPasswordChar = $true
    $field.SetBounds(20, 55, 460, 25)
    $reveal = New-Object Windows.Forms.CheckBox
    $reveal.Text = 'Show password'
    $reveal.SetBounds(20, 95, 220, 25)
    $reveal.Add_CheckedChanged({ $field.UseSystemPasswordChar = -not $reveal.Checked })
    $form.Controls.AddRange(@($label, $field, $reveal))
    try { $null = $form.ShowDialog() } finally { $field.Text = ''; $form.Dispose() }
    exit 0
}

if ($Mode -eq 'Shortcuts') {
    $url = [Uri]$RemoteUrl
    if ($url.Scheme -ne 'https' -or -not $url.DnsSafeHost.EndsWith('.ts.net')) {
        throw 'Use the verified Tailscale HTTPS URL.'
    }
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $webPath = Join-Path $desktop 'OpenCode Web.url'
    $loginPath = Join-Path $desktop 'OpenCode Login.lnk'
    if ((Test-Path -LiteralPath $webPath) -or (Test-Path -LiteralPath $loginPath)) {
        throw 'Desktop shortcuts already exist; preserve them.'
    }
    $web = $shell.CreateShortcut($webPath)
    $web.TargetPath = $url.AbsoluteUri
    $web.Save()
    $link = $shell.CreateShortcut($loginPath)
    $link.TargetPath = $powershell
    $link.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Mode ShowLogin -InstanceRoot "{1}"' -f $PSCommandPath, $InstanceRoot
    $link.WorkingDirectory = $PSScriptRoot
    $link.Save()
    @{ shortcutsCreated = $true } | ConvertTo-Json
    exit 0
}

if ($Mode -eq 'Register') {
    if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) { throw 'Windowless Python runtime is missing.' }
    $existing = Get-OwnedTask
    if ($existing) { throw 'Scheduled task already exists; preserve existing settings.' }
    $action = New-ScheduledTaskAction -Execute $pythonw -WorkingDirectory $PSScriptRoot -Argument (
        '"{0}" --powershell "{1}" --instance-root "{2}"' -f
        (Join-Path $PSScriptRoot 'launcher.py'), $powershell, $InstanceRoot)
    $principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null = Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger `
        -Settings $settings -Description $description
}

if ($Mode -eq 'Start') {
    $running = Get-Server
    if ($running) {
        [ordered]@{ status = 'already-running'; pid = $running.Id } | ConvertTo-Json
        exit 0
    }
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or -not (Test-Path -LiteralPath $config -PathType Leaf)) {
        throw 'OpenCode binary or configuration is missing.'
    }
    $login = Get-Login
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $binary
    # serve uses the same HTTP server/UI without opening a browser at every logon.
    $start.Arguments = 'serve --hostname 127.0.0.1 --port 4096 --pure --log-level WARN'
    $start.WorkingDirectory = $workspace
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['ComSpec'] = [Environment]::GetEnvironmentVariable('ComSpec', 'Machine')
    $start.EnvironmentVariables['PATHEXT'] = [Environment]::GetEnvironmentVariable('PATHEXT', 'Machine')
    $start.EnvironmentVariables['OPENCODE_SERVER_USERNAME'] = $login.UserName
    $start.EnvironmentVariables['OPENCODE_SERVER_PASSWORD'] = $login.GetNetworkCredential().Password
    $start.EnvironmentVariables['OPENCODE_CONFIG'] = $config
    $start.EnvironmentVariables['XDG_DATA_HOME'] = Join-Path $InstanceRoot 'data'
    $start.EnvironmentVariables['XDG_CONFIG_HOME'] = Join-Path $InstanceRoot 'config'
    $start.EnvironmentVariables['XDG_CACHE_HOME'] = Join-Path $InstanceRoot 'cache'
    $start.EnvironmentVariables['XDG_STATE_HOME'] = Join-Path $InstanceRoot 'state'
    $server = [Diagnostics.Process]::Start($start)
    $start.EnvironmentVariables.Remove('OPENCODE_SERVER_PASSWORD')
    [ordered]@{ pid = $server.Id; startedAt = $server.StartTime.ToUniversalTime().ToString('o'); binary = $binary } |
        ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    [ordered]@{ status = 'started-not-yet-verified'; pid = $server.Id } | ConvertTo-Json
    if ($WaitForExit) { $server.WaitForExit(); exit $server.ExitCode }
    exit 0
}

$running = Get-Server
$task = Get-OwnedTask
[ordered]@{
    running = [bool]$running
    pid = if ($running) { $running.Id } else { $null }
    endpoint = 'http://127.0.0.1:4096'
    workspace = $workspace
    taskRegistered = [bool]$task
    taskState = if ($task) { [string]$task.State } else { $null }
    logonType = if ($task) { [string]$task.Principal.LogonType } else { $null }
    runLevel = if ($task) { [string]$task.Principal.RunLevel } else { $null }
} | ConvertTo-Json
