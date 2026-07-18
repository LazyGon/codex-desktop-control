[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ControlArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path (Split-Path -Parent $PSCommandPath) 'codex-control.mjs'
& $node $script @ControlArguments
exit $LASTEXITCODE
