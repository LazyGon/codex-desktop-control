function Invoke-CodexDesktopNormalShutdown {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [Parameter(Mandatory)][string]$ExpectedExecutable,
        [Parameter(Mandatory)][string]$ExpectedStartTimeUtc,
        [switch]$Execute
    )
    if (-not ('CodexDesktopShutdown' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'CodexDesktopShutdown.cs')
    }
    $started=[DateTimeOffset]::Parse($ExpectedStartTimeUtc)
    [CodexDesktopShutdown]::Run($ProcessId,$ExpectedExecutable,$started.UtcDateTime.Ticks,[bool]$Execute)
}
