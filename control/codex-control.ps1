[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ControlArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'launcher'
. (Join-Path $launcherRoot 'CodexNodeRuntime.ps1')
$node = Initialize-CodexNodeRuntime -StateRoot (Join-Path $launcherRoot 'state')
$script = Join-Path (Split-Path -Parent $PSCommandPath) 'codex-control.mjs'
& $node $script @ControlArguments
exit $LASTEXITCODE
