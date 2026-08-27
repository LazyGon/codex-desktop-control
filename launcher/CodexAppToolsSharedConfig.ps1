Set-StrictMode -Version Latest

$script:CodexAppToolsConfigBegin = '# BEGIN CODEX DESKTOP CONTROL: shared codex_app transport'
$script:CodexAppToolsConfigEnd = '# END CODEX DESKTOP CONTROL: shared codex_app transport'

function ConvertTo-CodexTomlString {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $Value | ConvertTo-Json -Compress
}

function Get-CodexAppToolsSharedDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LauncherRoot,
        [string]$NodeExecutable
    )

    $resolvedLauncherRoot = [IO.Path]::GetFullPath($LauncherRoot)
    $bridgeScript = [IO.Path]::GetFullPath((Join-Path $resolvedLauncherRoot 'codex-app-tools-bridge.mjs'))
    if ([string]::IsNullOrWhiteSpace($NodeExecutable)) {
        $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    }
    $resolvedNodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)
    if (-not (Test-Path -LiteralPath $resolvedNodeExecutable -PathType Leaf)) {
        throw "Node.js executable was not found: $resolvedNodeExecutable"
    }
    if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) {
        throw "The shared codex-app-tools bridge was not found: $bridgeScript"
    }

    $command = ConvertTo-CodexTomlString -Value $resolvedNodeExecutable
    $argument = ConvertTo-CodexTomlString -Value $bridgeScript
    $workingDirectory = ConvertTo-CodexTomlString -Value $resolvedLauncherRoot
    $inlineTable = (
        '{ command = ' + $command +
        ', args = [' + $argument + ']' +
        ', cwd = ' + $workingDirectory +
        ', enabled = true' +
        ', default_tools_approval_mode = "approve"' +
        ', tools = {' +
            ' automation_update = { approval_mode = "prompt" }' +
            ', create_thread = { approval_mode = "prompt" }' +
            ', send_message_to_thread = { approval_mode = "prompt" }' +
            ', fork_thread = { approval_mode = "prompt" }' +
            ', handoff_thread = { approval_mode = "prompt" }' +
        ' }' +
        ', startup_timeout_sec = 30' +
        ', tool_timeout_sec = 3600' +
        ', omit_tools_from = ["deferred", "code_mode"]' +
        ' }'
    )

    [pscustomobject]@{
        SchemaVersion = 1
        NodeExecutable = $resolvedNodeExecutable
        BridgeScript = $bridgeScript
        WorkingDirectory = $resolvedLauncherRoot
        InlineTable = $inlineTable
        Override = "mcp_servers.codex_app=$inlineTable"
    }
}

function Install-CodexAppToolsSharedConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LauncherRoot,
        [string]$NodeExecutable,
        [string]$ConfigPath
    )

    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        $codexRoot = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
            Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
        }
        else {
            [IO.Path]::GetFullPath($env:CODEX_HOME)
        }
        $ConfigPath = Join-Path $codexRoot 'config.toml'
    }
    $resolvedConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    $definition = Get-CodexAppToolsSharedDefinition `
        -LauncherRoot $LauncherRoot `
        -NodeExecutable $NodeExecutable
    $mutex = [Threading.Mutex]::new($false, 'Local\CodexAppToolsSharedConfigInstall')
    $ownsMutex = $false
    try {
        try {
            $ownsMutex = $mutex.WaitOne([TimeSpan]::FromSeconds(10))
        }
        catch [Threading.AbandonedMutexException] {
            $ownsMutex = $true
        }
        if (-not $ownsMutex) {
            throw 'Another process is updating the shared codex_app transport configuration.'
        }

        $configExists = [IO.File]::Exists($resolvedConfigPath)
        $original = if ($configExists) {
            [IO.File]::ReadAllText($resolvedConfigPath)
        }
        else {
            ''
        }
        $newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
        $begin = [regex]::Escape($script:CodexAppToolsConfigBegin)
        $end = [regex]::Escape($script:CodexAppToolsConfigEnd)
        $managedPattern = "(?s)\A$begin\r?\n.*?\r?\n$end(?:\r?\n){0,2}"
        $managedMatch = [regex]::Match($original, $managedPattern)
        $hasBegin = $original.Contains($script:CodexAppToolsConfigBegin)
        $hasEnd = $original.Contains($script:CodexAppToolsConfigEnd)
        if (($hasBegin -or $hasEnd) -and -not $managedMatch.Success) {
            throw 'The managed shared codex_app transport block is malformed. No config was changed.'
        }
        if (-not $managedMatch.Success) {
            $unmanagedPattern = '(?im)^\s*(?:\[{1,2}\s*mcp_servers\.codex_app(?:\.|\s*\])|mcp_servers\.codex_app\s*=)'
            if ([regex]::IsMatch($original, $unmanagedPattern)) {
                throw 'An unmanaged mcp_servers.codex_app definition already exists. No config was changed.'
            }
        }

        $managedBlock = (
            $script:CodexAppToolsConfigBegin + $newline +
            'mcp_servers.codex_app = ' + $definition.InlineTable + $newline +
            $script:CodexAppToolsConfigEnd + $newline + $newline
        )
        $remaining = if ($managedMatch.Success) {
            $original.Substring($managedMatch.Length)
        }
        else {
            $original
        }
        $desired = $managedBlock + $remaining
        if ($desired -ceq $original) {
            return [pscustomobject]@{
                Changed = $false
                ConfigPath = $resolvedConfigPath
                BackupPath = $null
                Definition = $definition
            }
        }

        $configRoot = Split-Path -Parent $resolvedConfigPath
        New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
        $temporaryPath = "$resolvedConfigPath.$PID.tmp"
        $backupPath = "$resolvedConfigPath.codex-desktop-control.$(Get-Date -Format 'yyyyMMdd-HHmmssfff').bak"
        try {
            [IO.File]::WriteAllText(
                $temporaryPath,
                $desired,
                [Text.UTF8Encoding]::new($false)
            )
            if ($configExists) {
                if (
                    -not [IO.File]::Exists($resolvedConfigPath) -or
                    [IO.File]::ReadAllText($resolvedConfigPath) -cne $original
                ) {
                    throw 'config.toml changed during the managed update. No config was replaced.'
                }
                [IO.File]::Replace($temporaryPath, $resolvedConfigPath, $backupPath)
            }
            else {
                if ([IO.File]::Exists($resolvedConfigPath)) {
                    throw 'config.toml appeared during the managed update. No config was replaced.'
                }
                [IO.File]::Move($temporaryPath, $resolvedConfigPath)
                $backupPath = $null
            }
        }
        finally {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }

        [pscustomobject]@{
            Changed = $true
            ConfigPath = $resolvedConfigPath
            BackupPath = $backupPath
            Definition = $definition
        }
    }
    finally {
        if ($ownsMutex) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}
