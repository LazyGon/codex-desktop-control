[CmdletBinding()]
param(
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$runtimePath = Join-Path $root 'data\runtime.json'
$lockPath = Join-Path $root 'data\bridge.lock'
$runtime = $null
if (Test-Path -LiteralPath $runtimePath) {
    $runtime = Get-Content -Raw -Encoding UTF8 -LiteralPath $runtimePath | ConvertFrom-Json
}

$pidValue = $null
$processAlive = $false
if (Test-Path -LiteralPath $lockPath) {
    $parsedPid = 0
    if ([int]::TryParse((Get-Content -Raw -LiteralPath $lockPath).Trim(), [ref]$parsedPid)) {
        $pidValue = $parsedPid
        $processAlive = $null -ne (Get-Process -Id $parsedPid -ErrorAction SilentlyContinue)
    }
}

$task = Get-ScheduledTask -TaskName 'Codex Discord Remote' -ErrorAction SilentlyContinue
$hostExecutable = [IO.Path]::GetFullPath((Join-Path $root 'CodexDiscordRemoteHost.exe'))
$hostProcess = @(Get-Process -Name 'CodexDiscordRemoteHost' -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            [string]::Equals(
                [IO.Path]::GetFullPath($_.Path),
                $hostExecutable,
                [StringComparison]::OrdinalIgnoreCase)
        }
        catch {
            $false
        }
    } |
    Select-Object -First 1)
$ready = $false
$readyStatus = $null
$endpoint = if ($runtime -and $runtime.codex.endpoint) { [string]$runtime.codex.endpoint } else { 'ws://127.0.0.1:8798' }
try {
    $readyUrl = $endpoint -replace '^ws:', 'http:' -replace '^wss:', 'https:'
    $readyUrl = $readyUrl.TrimEnd('/') + '/readyz'
    $response = Invoke-WebRequest -UseBasicParsing -Uri $readyUrl -TimeoutSec 3
    $ready = $response.StatusCode -eq 200
    $readyStatus = $response.StatusCode
}
catch {
    $readyStatus = $_.Exception.Message
}

$status = [ordered]@{
    ProcessAlive = $processAlive
    Pid = $pidValue
    HostProcessAlive = $hostProcess.Count -eq 1
    HostPid = if ($hostProcess.Count -eq 1) { $hostProcess[0].Id } else { $null }
    HostProcessName = if ($hostProcess.Count -eq 1) { $hostProcess[0].ProcessName } else { $null }
    Phase = if ($runtime) { $runtime.phase } else { 'not-started' }
    DiscordReady = if ($runtime) { $runtime.discordReady } else { $false }
    DiscordUser = if ($runtime) { $runtime.discordUser } else { $null }
    CodexConnected = if ($runtime -and $runtime.codex) { $runtime.codex.connected } else { $false }
    AppServerReady = $ready
    AppServerStatus = $readyStatus
    Endpoint = $endpoint
    Bindings = if ($runtime -and $runtime.codex) { $runtime.codex.bindings } else { 0 }
    ActiveBindings = if ($runtime -and $runtime.codex -and $runtime.codex.PSObject.Properties.Name -contains 'activeBindings') { $runtime.codex.activeBindings } else { 0 }
    ArchivedBindings = if ($runtime -and $runtime.codex -and $runtime.codex.PSObject.Properties.Name -contains 'archivedBindings') { $runtime.codex.archivedBindings } else { 0 }
    ProjectCategories = if ($runtime -and $runtime.codex -and $runtime.codex.PSObject.Properties.Name -contains 'projectCategories') { $runtime.codex.projectCategories } else { 0 }
    UpdatedAt = if ($runtime) { $runtime.updatedAt } else { $null }
    ScheduledTaskState = if ($task) { [string]$task.State } else { 'NotInstalled' }
}

if ($Json) {
    $status | ConvertTo-Json -Depth 5
}
else {
    [pscustomobject]$status | Format-List
}
