param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Encoding UTF8 -Raw | ConvertFrom-Json
$root='C:\ProgramData\CodexAdminTerminal'
if(Test-Path -LiteralPath $job.receiptPath){throw 'Existing repair receipt; inspect rather than replay.'}
$receipt=[ordered]@{operationId=$job.operationId;phase='preflight';startedAt=[DateTimeOffset]::Now.ToString('o');operations=@();noPolicyChanges=$true}
function Save-Receipt {$tmp=$job.receiptPath+'.'+$PID+'.tmp';$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tmp -Encoding UTF8;Move-Item -LiteralPath $tmp -Destination $job.receiptPath -Force}
Save-Receipt
try {
    if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Use the already authorized admin host.'}
    $target=Join-Path $root 'Invoke-AdminTerminal.ps1'
    if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $job.beforeClientSha256){throw 'Installed client changed; inspect, no overwrite.'}
    foreach($asset in $job.files){
        if($asset.name -notin 'ProcessExitObserver.ps1','Invoke-AdminTerminal.ps1'){throw 'Unexpected repair target.'}
        if((Get-FileHash -LiteralPath $asset.source -Algorithm SHA256).Hash -ne $asset.sha256){throw 'Reviewed repair asset hash changed.'}
    }
    $backup=Join-Path $root 'Invoke-AdminTerminal.before-observer-repair-20261011.ps1'
    if(Test-Path -LiteralPath $backup){throw 'Repair backup exists; inspect, no replay.'}
    Copy-Item -LiteralPath $target -Destination $backup
    foreach($asset in $job.files){
        $destination=Join-Path $root $asset.name
        $op=[ordered]@{file=$asset.name;phase='copy-dispatching';expectedSha256=$asset.sha256}
        $receipt.operations+=$op;Save-Receipt
        Copy-Item -LiteralPath $asset.source -Destination $destination
        $op.actualSha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        if($op.actualSha256 -ne $asset.sha256){throw 'Installed repair asset hash mismatch; do not replay.'}
        $op.acl=(Get-Acl -LiteralPath $destination).Sddl
        $op.phase='hash-verified';Save-Receipt
    }
    $receipt.phase='completed';$receipt.finishedAt=[DateTimeOffset]::Now.ToString('o');Save-Receipt
} catch {$receipt.phase='failed-do-not-replay';$receipt.failure=$_.Exception.Message;Save-Receipt;exit 1}
