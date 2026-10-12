$ErrorActionPreference='Stop'
$root='C:\ProgramData\CodexAdminTerminal'
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Submit this script through the authorized admin terminal.'}
$config=Get-Content -LiteralPath (Join-Path $root 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
Disable-ScheduledTask -TaskName $config.taskName | Out-Null
[ordered]@{requestedAt=[DateTimeOffset]::Now.ToString('o');reason='User-requested revocation; stop after current operation completes, no installer termination.'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'stop-request.json') -Encoding UTF8
