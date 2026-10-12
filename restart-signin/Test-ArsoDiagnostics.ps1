param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$config=Get-Content -LiteralPath 'C:\ProgramData\CodexRestartSignIn\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if($identity.User.Value -ne $config.userSid -or -not ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))){throw 'Current-user administrator token required.'}
$logName='Microsoft-Windows-LSA/Operational'
$log=[System.Diagnostics.Eventing.Reader.EventLogConfiguration]::new($logName)
function Save-SafeJson([string]$Path,$Value) {
    $tmp=$Path+'.'+$PID+'.tmp'
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}
try {
    if($job.mode -eq 'prepare'){
        if(Test-Path -LiteralPath $job.baselinePath){throw 'Diagnostic preparation already admitted; inspect, do not repeat.'}
        $baseline=[ordered]@{operationId=$job.restartOperationId;userSid=$identity.User.Value;logName=$logName;originalEnabled=$log.IsEnabled;preparedAt=[DateTimeOffset]::Now.ToString('o');phase='recorded-before-change'}
        Save-SafeJson $job.baselinePath $baseline
        try {
            if(-not $log.IsEnabled){$log.IsEnabled=$true;$log.SaveChanges()}
            $actual=[System.Diagnostics.Eventing.Reader.EventLogConfiguration]::new($logName)
            try {if(-not $actual.IsEnabled){throw 'ARSO diagnostic channel not enabled.'}}finally{$actual.Dispose()}
            $baseline.phase='ready-for-one-test';Save-SafeJson $job.baselinePath $baseline
            Save-SafeJson $job.receiptPath @{phase='prepared';operationId=$job.operationId;restartOperationId=$job.restartOperationId;userSid=$identity.User.Value;elevated=$true;pid=$PID;logName=$logName;originalEnabled=$baseline.originalEnabled;temporaryEnabled=$true;noLogClear=$true;noCredentialOrAccountBodyRead=$true;observedAt=[DateTimeOffset]::Now.ToString('o')}
        } catch {
            $log.IsEnabled=$baseline.originalEnabled;$log.SaveChanges()
            $baseline.phase='failed-original-setting-restored';Save-SafeJson $job.baselinePath $baseline
            throw
        }
    } elseif($job.mode -eq 'collect-restore'){
        if(Test-Path -LiteralPath $job.receiptPath){throw 'Diagnostic result already exists; do not repeat.'}
        $baseline=Get-Content -LiteralPath $job.baselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if($baseline.operationId -ne $job.restartOperationId -or $baseline.userSid -ne $identity.User.Value -or $baseline.logName -ne $logName){throw 'Diagnostic baseline identity mismatch.'}
        $events=@();$readError=$null
        try {
            # Only public numeric event identifiers/times are retained. Never
            # format Message/Properties/XML: these can contain account details.
            $events=@(Get-WinEvent -FilterHashtable @{LogName=$logName;Id=320,321,322;StartTime=([DateTimeOffset]$baseline.preparedAt).LocalDateTime} -ErrorAction Stop | ForEach-Object {@{id=$_.Id;recordId=$_.RecordId;timeCreated=$_.TimeCreated.ToUniversalTime().ToString('o')}})
        } catch {$readError=$_.FullyQualifiedErrorId}
        finally {
            $log.IsEnabled=$baseline.originalEnabled;$log.SaveChanges()
        }
        $actual=[System.Diagnostics.Eventing.Reader.EventLogConfiguration]::new($logName)
        try {$restored=($actual.IsEnabled -eq $baseline.originalEnabled)}finally{$actual.Dispose()}
        if(-not $restored){throw 'Original diagnostic-channel state was not restored.'}
        Save-SafeJson $job.receiptPath @{phase='collected-original-channel-state-restored';operationId=$job.operationId;restartOperationId=$job.restartOperationId;events=$events;eventReadError=$readError;channelStateRestored=$true;originalEnabled=$baseline.originalEnabled;userSid=$identity.User.Value;elevated=$true;pid=$PID;observedAt=[DateTimeOffset]::Now.ToString('o');noCredentialOrAccountBodyRead=$true}
    } else {throw 'Use prepared diagnostic modes only.'}
}finally{$log.Dispose()}
