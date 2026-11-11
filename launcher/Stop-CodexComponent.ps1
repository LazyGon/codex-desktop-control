[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Shared','Desktop','Bridge')][string]$Component,
    [Parameter(Mandatory)][guid]$OperationId,
    [Parameter(Mandatory)][string]$ResultPath,
    [switch]$Force,
    [ValidateRange(0,30)][int]$GracefulTimeoutSeconds = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CodexDesktopPackage.ps1')
. (Join-Path $PSScriptRoot 'CodexComponentIdentity.ps1')
. (Join-Path $PSScriptRoot 'CodexComponentStop.ps1')

try {
    $receipt = Invoke-CodexComponentStop -Component $Component -OperationId $OperationId -ResultPath $ResultPath `
        -LauncherRoot $PSScriptRoot -Force:$Force -GracefulTimeoutSeconds $GracefulTimeoutSeconds
    $receipt | ConvertTo-Json -Depth 8 -Compress
    if ($receipt.phase -eq 'completed') { exit 0 }
    if ($receipt.phase -eq 'unknown') { exit 3 }
    exit 1
}
catch {
    Write-Error $_ -ErrorAction Continue
    exit 2
}
