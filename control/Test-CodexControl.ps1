[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = (Get-Command node.exe -ErrorAction Stop).Source
$controlScript = Join-Path (Split-Path -Parent $PSCommandPath) 'codex-control.mjs'

function Invoke-ControlJson {
    param([string[]]$Arguments)

    $output = & $node $controlScript @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "codex-control failed: $($Arguments -join ' ')"
    }
    $output | ConvertFrom-Json
}

$status = Invoke-ControlJson -Arguments @('status', '--compact')
if ($status.ready -ne $true) {
    throw 'Shared app-server is not ready.'
}

$list = Invoke-ControlJson -Arguments @('list', '--limit', '3', '--compact')
if ($list.tasks.Count -eq 0) {
    throw 'No tasks were returned.'
}

$targetId = [string]$list.tasks[0].id
$catchup = Invoke-ControlJson -Arguments @('catchup', $targetId, '--messages', '2', '--chars', '1000', '--compact')
if ($catchup.id -ne $targetId) {
    throw 'Catch-up returned the wrong task.'
}

[pscustomobject]@{
    Success = $true
    Endpoint = $status.endpoint
    EndpointSource = $status.endpointSource
    ListedTaskCount = $list.tasks.Count
    CatchupTaskId = $catchup.id
    CatchupMessageCount = $catchup.messages.Count
}
