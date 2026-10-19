param(
    [Parameter(Mandatory = $true)][Guid]$OperationId,
    [string]$InstanceRoot = 'D:\AI\OpenCode'
)
$ErrorActionPreference = 'Stop'
$login = Import-Clixml -LiteralPath (Join-Path $InstanceRoot 'credentials\login.xml')
$headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($login.UserName + ':' + $login.GetNetworkCredential().Password)) }
$endpoint = 'http://127.0.0.1:4096'
$runName = 'setup-smoke-' + $OperationId.ToString('N')
$targetDirectory = Join-Path $InstanceRoot ('projects\mobile-apps\' + $runName)
$target = Join-Path $targetDirectory 'index.html'
$receipt = Join-Path $InstanceRoot ('state\smoke-' + $OperationId.ToString('N') + '.json')
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $receipt)) {
    throw 'Smoke target or request receipt already exists. Reconcile by exact session; do not replay.'
}
$null = New-Item -ItemType Directory -Path $targetDirectory -Force
$claim = [IO.File]::Open($receipt, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $bytes = [Text.Encoding]::UTF8.GetBytes((@{ operationId = $OperationId.ToString(); phase = 'creating'; target = $target } | ConvertTo-Json))
    $claim.Write($bytes, 0, $bytes.Length)
    $claim.Flush($true)
} finally { $claim.Dispose() }
$create = @{
    title = 'Setup smoke test'
    permission = @(
        @{ permission = '*'; pattern = '*'; action = 'deny' },
        @{ permission = 'edit'; pattern = ('*' + $runName + '/index.html'); action = 'allow' },
        @{ permission = 'read'; pattern = ('*' + $runName + '/index.html'); action = 'allow' }
    )
} | ConvertTo-Json -Depth 8
$session = Invoke-RestMethod -Method Post -Uri "$endpoint/session" -Headers $headers -ContentType 'application/json' -Body $create
@{ sessionId = $session.id; phase = 'created'; target = $target } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
$body = @{
    model = @{ providerID = 'ollama'; modelID = 'qwen3.5-opencode:4b' }
    agent = 'build'
    parts = @(@{ type = 'text'; text = (
        'Use the write tool to create only ' + $target.Replace('\', '/') +
        ' containing exactly this text: <!doctype html><html><title>Setup</title><body>OPEN_CODE_SETUP_OK</body></html>' +
        '. Do not run any commands, delegate tasks, access the network, or edit any other file. After writing reply SETUP_OK.'
    ) })
} | ConvertTo-Json -Depth 8
@{ sessionId = $session.id; phase = 'dispatching'; target = $target } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
# One request only. Any interrupted/uncertain request is reconciled by exact session ID, never resent.
$response = Invoke-RestMethod -Method Post -Uri "$endpoint/session/$($session.id)/message" -Headers $headers -ContentType 'application/json' -Body $body
$history = Invoke-RestMethod -Uri "$endpoint/session/$($session.id)/message" -Headers $headers
$actual = if (Test-Path -LiteralPath $target) { Get-Content -LiteralPath $target -Raw } else { '' }
$report = [ordered]@{
    sessionId = $session.id
    phase = 'settled'
    model = $response.info.modelID
    finish = $response.info.finish
    error = $response.info.error
    fileCreated = Test-Path -LiteralPath $target
    markerPresent = $actual.Contains('OPEN_CODE_SETUP_OK')
    exactContent = $actual.Trim() -eq '<!doctype html><html><title>Setup</title><body>OPEN_CODE_SETUP_OK</body></html>'
    bytes = [Text.Encoding]::UTF8.GetByteCount($actual)
    toolStates = @($history | ForEach-Object { $_.parts } | Where-Object type -eq 'tool' |
        ForEach-Object { @{ tool = $_.tool; status = $_.state.status } })
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receipt -Encoding UTF8
$report | ConvertTo-Json -Depth 8
if ($report.error -or -not $report.exactContent -or -not @($report.toolStates | Where-Object status -eq 'completed').Count) { exit 1 }
