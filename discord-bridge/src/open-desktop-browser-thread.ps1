param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')]
    [string] $ThreadId
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$launcherType = [Windows.System.Launcher, Windows.System, ContentType = WindowsRuntime]
$options = [Windows.System.LauncherOptions, Windows.System, ContentType = WindowsRuntime]::new()
$options.TargetApplicationPackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0'
$data = [Windows.Foundation.Collections.ValueSet, Windows.Foundation.Collections, ContentType = WindowsRuntime]::new()
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
if (!$asTask) { throw 'Windows URI activation is unavailable.' }

# Use the package-targeted overload, so a different default handler never
# receives the thread ID. A true result is dispatch, not browser readiness.
$activation = $launcherType::LaunchUriAsync([uri] ('codex://threads/' + $ThreadId), $options, $data)
$task = $asTask.MakeGenericMethod([bool]).Invoke($null, @($activation))
if (!$task.GetAwaiter().GetResult()) { throw 'Windows did not accept Desktop URI activation.' }
