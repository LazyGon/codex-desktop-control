param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$auth=Get-Content -LiteralPath $job.authorizationPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($job.operationId -ne $auth.operationId -or $job.threadId -ne $auth.threadId -or $job.workspace -ne $auth.workspace -or $identity.User.Value -ne $auth.userSid -or -not ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))){throw 'Exact owning restart/admin identity required.'}
$wrapper=Join-Path $job.workspace 'restart-signin\Run-RestartSignIn.ps1'
if((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash -ne $job.restartWrapperSha256){throw 'Reviewed restart wrapper changed.'}
if(Test-Path -LiteralPath $job.receiptPath){throw 'Receipt already exists; never replay this operation.'}
$receipt=[ordered]@{operationId=$job.operationId;threadId=$job.threadId;phase='admitted-preflight-and-own-idle-wait';pid=$PID;userSid=$identity.User.Value;elevated=$true;startedAt=[DateTimeOffset]::Now.ToString('o');authorizationPath=$job.authorizationPath;postbootPath=$job.postbootPath;restartIssued=$false}
function Save-Receipt {
    $tmp=$job.receiptPath+'.'+$PID+'.tmp'
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $job.receiptPath -Force
}
Save-Receipt
try {
    # Invoke in this admitted worker's PID. The protected implementation binds it
    # to the common admin result, then independently waits for the owner's idle.
    & $wrapper -Mode Execute -AuthorizationPath $job.authorizationPath -PostbootJobPath $job.postbootPath
    $op=Get-Content -LiteralPath ('C:\ProgramData\CodexRestartSignIn\operations\'+$job.operationId+'.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $receipt.phase=$op.phase
    $receipt.restartIssued=($op.apiReturn -eq 0 -and $op.phase -eq 'restart-request-accepted')
    $receipt.actualBootVerified=$false
    $receipt.finishedAt=[DateTimeOffset]::Now.ToString('o')
    Save-Receipt
} catch {
    $receipt.phase='failed-or-unknown-read-protected-operation-first'
    $receipt.failureType=$_.Exception.GetType().FullName
    $receipt.finishedAt=[DateTimeOffset]::Now.ToString('o')
    Save-Receipt
    throw
}
