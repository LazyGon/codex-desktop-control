param(
    [string]$InstanceRoot = 'D:\AI\OpenCode',
    [string]$RemoteUrl = ''
)
$ErrorActionPreference = 'Stop'
$login = Import-Clixml -LiteralPath (Join-Path $InstanceRoot 'credentials\login.xml')
$headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($login.UserName + ':' + $login.GetNetworkCredential().Password)) }
$endpoint = 'http://127.0.0.1:4096'
$health = Invoke-RestMethod -Uri "$endpoint/global/health" -Headers $headers
if (-not $health.healthy) { throw 'OpenCode health check failed.' }
$ollama = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version'
$installed = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags'
if ('qwen3.5-opencode:4b' -notin @($installed.models.name)) { throw 'OpenCode model alias is missing.' }
$config = Invoke-RestMethod -Uri "$endpoint/config" -Headers $headers
$providers = Invoke-RestMethod -Uri "$endpoint/provider" -Headers $headers
$paths = Invoke-RestMethod -Uri "$endpoint/path" -Headers $headers
if ($config.model -ne 'ollama/qwen3.5-opencode:4b' -or
    (@($config.enabled_providers) -join ',') -ne 'ollama' -or
    (@($providers.connected) -join ',') -ne 'ollama') { throw 'Unexpected model/provider configuration.' }
if ($config.share -ne 'disabled' -or $config.permission.edit -ne 'ask' -or $config.permission.bash -ne 'ask') {
    throw 'Sharing or approval configuration changed.'
}
if ($paths.directory -ne (Join-Path $InstanceRoot 'projects\mobile-apps')) { throw 'Unexpected workspace.' }
$ui = Invoke-WebRequest -Uri $endpoint -Headers $headers -UseBasicParsing
if ($ui.StatusCode -ne 200 -or $ui.Headers['Content-Type'] -notmatch 'text/html') { throw 'Web UI not served.' }
$assets = @([regex]::Matches($ui.Content, '<script[^>]+src="([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
if (-not $assets.Count) { throw 'Web UI has no script entry point.' }
foreach ($asset in $assets) {
    $assetUrl = New-Object Uri([Uri]($endpoint + '/'), $asset)
    if ($assetUrl.Host -ne '127.0.0.1') { throw 'Unexpected external UI script origin.' }
    $loaded = Invoke-WebRequest -Uri $assetUrl.AbsoluteUri -Headers $headers -UseBasicParsing
    if ($loaded.StatusCode -ne 200) { throw 'Web UI script failed to load.' }
}
$report = [ordered]@{
    healthy = $health.healthy
    version = $health.version
    ollamaVersion = $ollama.version
    model = $config.model
    enabledProviders = @($config.enabled_providers)
    connectedProviders = @($providers.connected)
    workspace = $paths.directory
    state = $paths.state
    config = $paths.config
    uiStatus = $ui.StatusCode
    uiBytes = $ui.RawContentLength
    uiScriptsLoaded = $assets.Count
    remote = $null
}
if ($RemoteUrl) {
    $remote = $RemoteUrl.TrimEnd('/')
    $unauthorized = $null
    try { $null = Invoke-WebRequest -Uri "$remote/config" -UseBasicParsing } catch {
        if ($_.Exception.Response) { $unauthorized = [int]$_.Exception.Response.StatusCode } else { throw }
    }
    if ($unauthorized -ne 401) { throw 'Unauthenticated remote API was not rejected with 401.' }
    $remoteHealth = Invoke-RestMethod -Uri "$remote/global/health" -Headers $headers
    $remoteUi = Invoke-WebRequest -Uri $remote -Headers $headers -UseBasicParsing
    if (-not $remoteHealth.healthy -or $remoteUi.StatusCode -ne 200) { throw 'Remote health/UI failed.' }
    $report.remote = @{ url = $remote; unauthorizedApiStatus = $unauthorized; healthy = $remoteHealth.healthy; uiStatus = $remoteUi.StatusCode }
}
$report | ConvertTo-Json -Depth 8
