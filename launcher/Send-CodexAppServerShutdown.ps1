param(
    [Parameter(Mandatory)][int]$ServerId,
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][long]$StartedUtcTicks,
    [Parameter(Mandatory)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'CodexAppServerConsole.cs')
    [CodexAppServerConsole]::RequestShutdown($ServerId, $Executable, $StartedUtcTicks)
    [IO.File]::WriteAllText($ResultPath, 'Signal accepted.')
    exit 0
}
catch {
    [IO.File]::WriteAllText($ResultPath, $_.Exception.Message)
    exit 1
}
