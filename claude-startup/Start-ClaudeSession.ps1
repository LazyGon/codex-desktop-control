param(
    [Parameter(Mandatory)][ValidateSet('Conversation','Haiku')][string]$Session,
    [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Session.ps1')
$root=Split-Path $PSScriptRoot -Parent
$state=Join-Path $root 'state/claude-startup'
$null=New-Item -ItemType Directory -Path $state -Force
$exe=Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe'
$work=Join-Path $env:USERPROFILE 'Documents/ChatGPT/その他'
$debug=Join-Path $state ($Session.ToLowerInvariant()+'-debug.log')
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex=[Threading.Mutex]::new($false,('Local\ClaudeStartup-'+$sid+'-'+$Session))
$held=$false
function Find-Session {
    @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object {
        $_.ExecutablePath -eq $exe -and
        $_.SessionId -eq (Get-Process -Id $PID).SessionId -and
        (Test-ClaudeSessionCommand $_.CommandLine $Session)
    })
}
function Save-Outcome([string]$Status,$Processes,[int]$Attempt=0) {
    $value=[ordered]@{at=[DateTimeOffset]::Now.ToString('o');session=$Session;status=$Status;attempt=$Attempt;pids=@($Processes | ForEach-Object ProcessId);debugFile=$debug}
    if($Session -eq 'Conversation'){
        foreach($sessionProcess in @($Processes)){
            $live=Get-Process -Id $sessionProcess.ProcessId -ErrorAction Stop
            $connection=Publish-ClaudeMobileConnection -SessionDirectory (Join-Path $env:USERPROFILE '.claude/sessions') `
                -ProcessId $live.Id -ProcessStartFileTime ($live.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()) `
                -ExpectedSessionId $script:ClaudeConversationSessionId `
                -OutputPath (Join-Path $root 'state/agent-collaboration/mobile.json') -LaunchStatus $Status
            if($null -ne $connection){$value['remoteControl']=$connection}
        }
    }
    $value | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $state ($Session+'-status.json')) -Encoding UTF8
    $value | ConvertTo-Json -Compress
}
try {
    try {$held=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$held=$true}
    if(-not $held){Save-Outcome 'launcher-already-running' @();return}
    $existing=Find-Session
    if($existing.Count){Save-Outcome 'already-running' $existing;return}
    if($CheckOnly){Save-Outcome 'not-running-check-only' @();return}
    $arguments=if($Session -eq 'Conversation'){
        '--resume '+$script:ClaudeConversationSessionId+' --remote-control --permission-mode bypassPermissions'
    } else {
        '--model claude-haiku-5-5 --effort low --permission-mode bypassPermissions --name 雑談Haiku --remote-control 雑談Haiku'
    }
    $arguments+=' --debug-file "'+$debug+'"'
    for($attempt=1;$attempt -le 2;$attempt++){
        $existing=Find-Session
        if($existing.Count){Save-Outcome 'already-running' $existing $attempt;return}
        # Rotate the fixed debug file only when no matching session is running.
        if(Test-Path -LiteralPath $debug){Move-Item -LiteralPath $debug -Destination ($debug+'.previous') -Force}
        $process=Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $work -WindowStyle Minimized -PassThru
        for($tick=0;$tick -lt 15;$tick++){
            Start-Sleep -Seconds 4
            $process.Refresh()
            if($process.HasExited){break}
            if(Test-Path -LiteralPath $debug){
                $tail=Get-Content -LiteralPath $debug -Tail 100 -Encoding UTF8
                if($tail -match 'CCRClient.*heartbeat'){
                    Save-Outcome 'heartbeat-confirmed' @(@{ProcessId=$process.Id}) $attempt;return
                }
            }
        }
        $process.Refresh()
        if(-not $process.HasExited){Save-Outcome 'running-heartbeat-unconfirmed' @(@{ProcessId=$process.Id}) $attempt;return}
        if($attempt -eq 1){Start-Sleep -Seconds 30}
    }
    Save-Outcome 'exited-after-one-retry' @() 2
} finally {
    if($held){$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
