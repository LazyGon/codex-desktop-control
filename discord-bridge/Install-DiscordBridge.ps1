[CmdletBinding()]
param(
    [ValidatePattern('^\d{15,22}$')]
    [string]$ApplicationId,

    [ValidatePattern('^\d{15,22}$')]
    [string]$GuildId,

    [ValidatePattern('^\d{15,22}$')]
    [string[]]$AuthorizedUserIds,

    # Legacy compatibility.
    [ValidatePattern('^\d{15,22}$')]
    [string]$AuthorizedUserId,

    [ValidatePattern('^\d{15,22}$')]
    [string[]]$AllowedUserIds,

    [ValidatePattern('^\d{15,22}$')]
    [string[]]$CompletionMentionUserIds,

    # Legacy compatibility.
    [ValidatePattern('^\d{15,22}$')]
    [string]$CompletionMentionUserId,

    [Security.SecureString]$BotToken,

    [switch]$SkipScheduledTask,
    [switch]$EnablePlainMessageInput,
    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$configDir = Join-Path $root 'config'
$configPath = Join-Path $configDir 'config.json'
$tokenPath = Join-Path $configDir 'token.dpapi'
$startScript = Join-Path $root 'Start-DiscordBridge.ps1'
$statusScript = Join-Path $root 'Get-DiscordBridgeStatus.ps1'
$stopScript = Join-Path $root 'Stop-DiscordBridge.ps1'
$sharedLauncherPath = Join-Path (Split-Path -Parent $root) 'launcher\CodexSharedLauncher.exe'
$taskName = 'Codex Discord Remote'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $sharedLauncherPath -PathType Leaf)) {
    throw "Shared Desktop launcher is missing: $sharedLauncherPath. Run the repository root Install.ps1."
}

if (-not $ApplicationId) { $ApplicationId = Read-Host 'Discord Application ID' }
if ($ApplicationId -notmatch '^\d{15,22}$') { throw 'Application ID is invalid.' }
if (-not $GuildId) { $GuildId = Read-Host 'Discord Server (Guild) ID' }
if ($GuildId -notmatch '^\d{15,22}$') { throw 'Guild ID is invalid.' }
if (-not $BotToken -and (Test-Path -LiteralPath $tokenPath)) {
    $BotToken = ConvertTo-SecureString (Get-Content -Raw -Encoding UTF8 -LiteralPath $tokenPath).Trim()
}
if (-not $BotToken) { $BotToken = Read-Host 'Discord Bot Token' -AsSecureString }

$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($BotToken)
$plainToken = $null
try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $headers = @{ Authorization = "Bot $plainToken" }
    $bot = Invoke-RestMethod -Uri 'https://discord.com/api/v10/users/@me' -Headers $headers -Method Get
    if (-not $bot.bot) { throw 'The supplied token is not a Discord bot token.' }
    if ([string]$bot.id -ne $ApplicationId) {
        throw "Application ID $ApplicationId does not match bot user ID $($bot.id)."
    }

    $env:DISCORD_BOT_TOKEN = $plainToken
    Push-Location $root
    try {
        $diagnosticText = (& node.exe 'scripts\diagnose-discord.mjs' $GuildId | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Discord Gateway diagnostic failed with exit code $LASTEXITCODE" }
        $diagnostic = $diagnosticText | ConvertFrom-Json
    }
    finally {
        Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
        Pop-Location
    }
    $permissions = '2251800082246672'
    $invite = "https://discord.com/oauth2/authorize?client_id=$ApplicationId&permissions=$permissions&integration_type=0&scope=bot+applications.commands&guild_id=$GuildId&disable_guild_select=true"
    if (-not $diagnostic.targetVisible) {
        $visibleGuilds = @($diagnostic.guilds | ForEach-Object { "$($_.name) [$($_.id)]" }) -join ', '
        throw "The bot Gateway cannot see guild $GuildId. Visible guilds: $visibleGuilds. Install it with: $invite"
    }
    if (-not $diagnostic.targetPermissions.allRequired) {
        throw "The bot is in guild $GuildId but is missing one or more required permissions. Re-authorize it with: $invite"
    }
    $targetGuild = @($diagnostic.guilds | Where-Object { $_.id -eq $GuildId })[0]

    if (-not $AuthorizedUserIds -or $AuthorizedUserIds.Count -eq 0) {
        if ($AuthorizedUserId) {
            $AuthorizedUserIds = @($AuthorizedUserId)
        }
        elseif ($AllowedUserIds -and $AllowedUserIds.Count -gt 0) {
            $AuthorizedUserIds = @($AllowedUserIds)
        }
        elseif ($CompletionMentionUserId) {
            $AuthorizedUserIds = @($CompletionMentionUserId)
        }
        else {
            $AuthorizedUserIds = @([string]$diagnostic.targetOwnerId)
        }
    }
    $AuthorizedUserIds = @($AuthorizedUserIds | Select-Object -Unique)
    foreach ($userId in $AuthorizedUserIds) {
        if ($userId -notmatch '^\d{15,22}$') {
            throw "Authorized user ID is invalid: $userId"
        }
    }
    if (-not $PSBoundParameters.ContainsKey('CompletionMentionUserIds')) {
        $CompletionMentionUserIds = if ($CompletionMentionUserId) {
            @($CompletionMentionUserId)
        }
        else {
            @($AuthorizedUserIds[0])
        }
    }
    elseif (-not $CompletionMentionUserIds) {
        $CompletionMentionUserIds = @()
    }
    $CompletionMentionUserIds = @($CompletionMentionUserIds | Select-Object -Unique)
    foreach ($userId in $CompletionMentionUserIds) {
        if ($userId -notmatch '^\d{15,22}$') {
            throw "Completion mention user ID is invalid: $userId"
        }
    }

    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    $config = [ordered]@{
        applicationId = $ApplicationId
        guildId = $GuildId
        authorizedUserIds = @($AuthorizedUserIds)
        controlCategoryName = 'Codex Control'
        archiveCategoryName = 'Codex Archived'
        projectCategoryPrefix = 'Codex - '
        controlChannelName = 'codex-remote'
        alertsChannelName = 'codex-alerts'
        completionsChannelName = 'codex-completions'
        completionMentionUserIds = @($CompletionMentionUserIds)
        defaultWatchLevel = 'normal'
        taskListLimit = 20
        initialSnapshotMessages = 16
        liveUpdateIntervalMs = 2500
        taskSyncIntervalMs = 30000
        plainMessageInputEnabled = [bool]$EnablePlainMessageInput
        autoStartSharedDesktop = $true
        sharedLauncherPath = [IO.Path]::GetFullPath($sharedLauncherPath)
        appServerUrl = $null
    }
    $configJson = $config | ConvertTo-Json -Depth 10
    $configTemp = "$configPath.$PID.tmp"
    [IO.File]::WriteAllText($configTemp, "$configJson`n", [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $configTemp -Destination $configPath -Force

    $protectedToken = ConvertFrom-SecureString $BotToken
    $tokenTemp = "$tokenPath.$PID.tmp"
    [IO.File]::WriteAllText($tokenTemp, "$protectedToken`n", [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tokenTemp -Destination $tokenPath -Force

    $acl = Get-Acl -LiteralPath $tokenPath
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $tokenPath -AclObject $acl

    Push-Location $root
    try {
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
        & npm.cmd run check
        if ($LASTEXITCODE -ne 0) { throw "npm run check failed with exit code $LASTEXITCODE" }
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw "npm test failed with exit code $LASTEXITCODE" }
        $env:DISCORD_BOT_TOKEN = $plainToken
        & node.exe 'src\register-commands.mjs'
        if ($LASTEXITCODE -ne 0) { throw "Discord command registration failed with exit code $LASTEXITCODE" }
    }
    finally {
        Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
        Pop-Location
    }

    if ($SkipScheduledTask) {
        $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existingTask) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
    }
    else {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" -WorkingDirectory $root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
        $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Private Discord remote control for the shared Codex Desktop app-server.' -Force | Out-Null
    }

    $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex Remote'
    New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcuts = @(
        @{ Name = 'Start Codex Discord Remote.lnk'; Script = $startScript; Hidden = $true },
        @{ Name = 'Codex Discord Remote Status.lnk'; Script = $statusScript; Hidden = $false },
        @{ Name = 'Stop Codex Discord Remote.lnk'; Script = $stopScript; Hidden = $false }
    )
    foreach ($item in $shortcuts) {
        $shortcut = $shell.CreateShortcut((Join-Path $startMenuDir $item.Name))
        $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $windowArgument = if ($item.Hidden) { '-WindowStyle Hidden ' } else { '-NoExit ' }
        $shortcut.Arguments = "-NoLogo -NoProfile $windowArgument-ExecutionPolicy Bypass -File `"$($item.Script)`""
        $shortcut.WorkingDirectory = $root
        $shortcut.Save()
    }

    if (-not $NoStart) {
        if (-not $SkipScheduledTask) {
            Start-ScheduledTask -TaskName $taskName
        }
        else {
            Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $startScript)
        }
        $deadline = [DateTimeOffset]::Now.AddSeconds(45)
        $runtimePath = Join-Path $root 'data\runtime.json'
        $ready = $false
        while ([DateTimeOffset]::Now -lt $deadline) {
            Start-Sleep -Milliseconds 500
            if (Test-Path -LiteralPath $runtimePath) {
                try {
                    $runtime = Get-Content -Raw -Encoding UTF8 -LiteralPath $runtimePath | ConvertFrom-Json
                    if ($runtime.phase -eq 'running' -and $runtime.discordReady) {
                        $ready = $true
                        break
                    }
                }
                catch {}
            }
        }
        if (-not $ready) { throw 'Bridge did not report Discord-ready within 45 seconds. Check logs and Get-DiscordBridgeStatus.ps1.' }
        [console]::Beep(880, 160)
        Start-Sleep -Milliseconds 80
        [console]::Beep(1175, 220)
    }

    [pscustomobject]@{
        Installed = $true
        Bot = $bot.username
        Guild = $targetGuild.name
        AuthorizedUserIds = $AuthorizedUserIds -join ','
        CompletionMentionUserIds = $CompletionMentionUserIds -join ','
        ScheduledTask = if ($SkipScheduledTask) { 'Skipped' } else { $taskName }
        ConfigPath = $configPath
        TokenProtection = 'Windows DPAPI CurrentUser plus restricted ACL'
        StartMenu = $startMenuDir
    }
}
finally {
    $plainToken = $null
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
