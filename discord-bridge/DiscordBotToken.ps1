Set-StrictMode -Version Latest
# The bundled PowerShell 7 module directory can be inherited by Windows
# PowerShell 5.1. Load this host's Security manifest explicitly, not by name.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

function Get-DiscordCredentialAccessRules {
    param([string]$Path)
    $sections = [Security.AccessControl.AccessControlSections]::Access
    if ([IO.File].GetMethods().Name -contains 'GetAccessControl') {
        return [IO.File]::GetAccessControl($Path, $sections)
    }
    return [IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new($Path), $sections)
}

function Set-DiscordCredentialAccessRules {
    param([string]$Path, [Security.AccessControl.FileSecurity]$Acl)
    # Persist only modified DACL sections; never write the SACL/audit rules,
    # which would unnecessarily require the elevated SeSecurityPrivilege.
    if ([IO.File].GetMethods().Name -contains 'SetAccessControl') { [IO.File]::SetAccessControl($Path, $Acl) }
    else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), $Acl) }
}

function Write-DiscordProtectedBotToken {
    param([Parameter(Mandatory)][string]$TokenText,
          [Parameter(Mandatory)][string]$TokenPath)
    $secure = [Security.SecureString]::new()
    $absolutePath = [IO.Path]::GetFullPath($TokenPath)
    $tempPath = "$absolutePath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        foreach ($character in $TokenText.ToCharArray()) { $secure.AppendChar($character) }
        $secure.MakeReadOnly()
        $encrypted = Microsoft.PowerShell.Security\ConvertFrom-SecureString $secure
        [IO.Directory]::CreateDirectory((Split-Path -Parent $absolutePath)) | Out-Null
        [IO.File]::WriteAllText($tempPath, "$encrypted`n", [Text.UTF8Encoding]::new($false))
        $acl = Get-DiscordCredentialAccessRules -Path $tempPath
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($existingRule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleAll($existingRule) }
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
        Set-DiscordCredentialAccessRules -Path $tempPath -Acl $acl
        if ([IO.File]::Exists($absolutePath)) { [IO.File]::Replace($tempPath, $absolutePath, [NullString]::Value) }
        else { [IO.File]::Move($tempPath, $absolutePath) }
        $destinationAcl = Get-DiscordCredentialAccessRules -Path $absolutePath
        $destinationAcl.SetAccessRuleProtection($true, $false)
        foreach ($existingRule in @($destinationAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { $destinationAcl.RemoveAccessRuleAll($existingRule) }
        $destinationAcl.AddAccessRule($rule)
        Set-DiscordCredentialAccessRules -Path $absolutePath -Acl $destinationAcl
    }
    finally {
        $secure.Dispose()
        if ([IO.File]::Exists($tempPath)) { [IO.File]::Delete($tempPath) }
    }
}

function ConvertTo-DiscordBotTokenText {
    param([Parameter(Mandatory)][string]$Value)
    $normalized = $Value.Trim()
    if ($normalized.Length -ge 2 -and
        (($normalized[0] -eq '"' -and $normalized[$normalized.Length - 1] -eq '"') -or
         ($normalized[0] -eq "'" -and $normalized[$normalized.Length - 1] -eq "'"))) {
        $normalized = $normalized.Substring(1, $normalized.Length - 2).Trim()
    }
    if ($normalized -match '^(?i)Bot\s+') { $normalized = $normalized -replace '^(?i)Bot\s+', '' }
    return $normalized
}

function Test-DiscordBotIdentity {
    param([Parameter(Mandatory)][string]$TokenText,
          [Parameter(Mandatory)][string]$ApplicationId)
    $headers = @{ Authorization = "Bot $TokenText" }
    try {
        $bot = Invoke-RestMethod -Uri 'https://discord.com/api/v10/users/@me' -Headers $headers `
            -UserAgent 'DiscordBot (https://github.com/LazyGon/codex-desktop-control, 1.0)' -TimeoutSec 20
    }
    catch {
        $status = $null
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
        }
        $code = switch ($status) { 401 { 'AUTH_REJECTED' }; 403 { 'ACCESS_BLOCKED' }; 429 { 'RATE_LIMITED' }; default { 'NETWORK_ERROR' } }
        return [pscustomobject]@{ Valid = $false; Code = $code; HttpStatus = $status;
            BotId = $null; ErrorType = $_.Exception.GetType().FullName }
    }
    finally { $headers.Clear() }
    $botId = if ($bot.PSObject.Properties.Name -contains 'id' -and [string]$bot.id -match '^\d{15,22}$') { [string]$bot.id } else { $null }
    $isBot = $bot.PSObject.Properties.Name -contains 'bot' -and $bot.bot -eq $true
    $code = if (-not $isBot) { 'NOT_BOT' } elseif ($botId -ne $ApplicationId) { 'BOT_ID_MISMATCH' } else { 'VERIFIED' }
    return [pscustomobject]@{ Valid = $code -eq 'VERIFIED'; Code = $code; HttpStatus = 200;
        BotId = $botId; ErrorType = $null }
}
