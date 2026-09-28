[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$InstanceId,
    [Parameter(Mandatory)][string]$ListenHost,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$')][string]$PeerInstanceId,
    [Parameter(Mandatory)][string]$PeerHost,
    [ValidateRange(1,65535)][int]$Port = 18799
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
foreach ($address in @($ListenHost, $PeerHost)) {
    $parsedAddress = $null
    if (-not [Net.IPAddress]::TryParse($address, [ref]$parsedAddress)) { throw 'Use a Tailscale IPv4 address.' }
    $octets = $parsedAddress.GetAddressBytes()
    if ($octets.Length -ne 4 -or $octets[0] -ne 100 -or $octets[1] -lt 64 -or $octets[1] -gt 127) {
        throw 'Use a Tailscale IPv4 address in 100.64.0.0/10.'
    }
}
if ($InstanceId -eq $PeerInstanceId -or $ListenHost -eq $PeerHost) { throw 'The two PCs must have different identities and addresses.' }
$lockPath = Join-Path $PSScriptRoot 'data\bridge.lock'
if (Test-Path -LiteralPath $lockPath) {
    $bridgePid = 0
    if ([int]::TryParse((Get-Content -Raw -LiteralPath $lockPath).Trim(), [ref]$bridgePid) -and
        (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) {
        throw 'Stop the Bridge gracefully with Stop-DiscordBridge.ps1 before changing its config.'
    }
}
$configPath = Join-Path $PSScriptRoot 'config\config.json'
$original = [IO.File]::ReadAllText($configPath)
$config = $original | ConvertFrom-Json
$changes = @{
    multiPcEnabled = $true
    instanceId = $InstanceId
    taskListListenHost = $ListenHost
    taskListListenPort = $Port
    taskListPeerTimeoutMs = 8000
    taskListPeers = @(@{ instanceId = $PeerInstanceId; url = "http://${PeerHost}:$Port" })
    launcherStatePath = '..\launcher\state\current.json'
    appServerUrl = $null
}
foreach ($name in $changes.Keys) { $config | Add-Member -NotePropertyName $name -NotePropertyValue $changes[$name] -Force }
$tempPath = "$configPath.$PID.tmp"
$backupPath = "$configPath.multi-pc.$(Get-Date -Format 'yyyyMMdd-HHmmssfff').bak"
try {
    [IO.File]::WriteAllText($tempPath, (($config | ConvertTo-Json -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::ReadAllText($configPath) -cne $original) { throw 'Config changed concurrently; nothing replaced.' }
    [IO.File]::Replace($tempPath, $configPath, $backupPath)
}
finally { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
[pscustomobject]@{ Configured = $true; InstanceId = $InstanceId; BackupPath = $backupPath; Started = $false }
