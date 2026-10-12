param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Encoding UTF8 -Raw | ConvertFrom-Json
if($job.requireStandardUac){throw 'Admin-host jobs must not request an additional UAC.'}
if(-not $job.adminScript -or -not $job.operationId -or -not $job.threadId -or -not $job.workspace){throw 'Explicit admin script/operation/task/workspace are required.'}
if($job.adminExpectedScriptSha256 -and (Get-FileHash -LiteralPath $job.adminScript -Algorithm SHA256).Hash -ne $job.adminExpectedScriptSha256){throw 'Reviewed admin worker hash changed; do not submit.'}
# Windows PowerShell -File cannot marshal a native string[] argument reliably.
# Call the shared client with a typed array inside this PowerShell worker.
& 'C:\ProgramData\CodexAdminTerminal\Invoke-AdminTerminal.ps1' -ThreadId $job.threadId -ScriptPath $job.adminScript -Workspace $job.workspace -Purpose $job.stage -OperationId $job.operationId -ScriptArguments @('-JobPath',$JobPath) -Wait
exit ([int]$LASTEXITCODE)
