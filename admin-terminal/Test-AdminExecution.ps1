param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Encoding UTF8 -Raw | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$result=[ordered]@{operation='read-only-admin-token-check';userSid=$identity.User.Value;elevated=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);pid=$PID;observedAt=[DateTimeOffset]::Now.ToString('o')}
$result | ConvertTo-Json | Set-Content -LiteralPath $job.resultPath -Encoding UTF8
if(-not $result.elevated){exit 1}
