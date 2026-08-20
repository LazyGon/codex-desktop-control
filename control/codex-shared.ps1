[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path (Split-Path -Parent $PSCommandPath) 'codex-shared.mjs'
& $node $script @CodexArguments
exit $LASTEXITCODE
