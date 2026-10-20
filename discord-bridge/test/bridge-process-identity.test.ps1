Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$file=Join-Path $PSScriptRoot '..\Get-DiscordBridgeStatus.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'PowerShell syntax errors.' }
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-BridgeProcessIdentity'},$false)
. ([scriptblock]::Create($definition.Extent.Text))
$runtime=[pscustomobject]@{pid=42;bridgeRoot='C:\bridge';startedAt='2026-10-21T00:05:00Z'}
$process=[pscustomobject]@{Id=42;ProcessName='node';StartTime=[datetime]::Parse('2026-10-21T00:00:00Z').ToUniversalTime()}
if (-not (Test-BridgeProcessIdentity $process $runtime 42 'C:\bridge')) { throw 'Slow initialization falsely rejected.' }
$process.StartTime=[datetime]::Parse('2026-10-21T00:06:00Z').ToUniversalTime()
if (Test-BridgeProcessIdentity $process $runtime 42 'C:\bridge') { throw 'Reused PID accepted an older runtime.' }
$process.StartTime=[datetime]::Parse('2026-10-21T00:00:00Z').ToUniversalTime()
if (Test-BridgeProcessIdentity $process $runtime 43 'C:\bridge') { throw 'Wrong PID accepted.' }
if (Test-BridgeProcessIdentity $process $runtime 42 'C:\another-bridge') { throw 'Wrong Bridge root accepted.' }
$process.ProcessName='another-process'
if (Test-BridgeProcessIdentity $process $runtime 42 'C:\bridge') { throw 'Wrong executable type accepted.' }
$process.ProcessName='node';$runtime.startedAt='not-a-time'
if (Test-BridgeProcessIdentity $process $runtime 42 'C:\bridge') { throw 'Invalid runtime timestamp accepted.' }
Write-Output 'Bridge process identity contracts passed.'
