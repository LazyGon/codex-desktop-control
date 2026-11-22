$script:ClaudeConversationSessionId='5467c555-7279-5b55-b8ce-e262b1e2e1f7'

function Test-ClaudeSessionCommand([string]$CommandLine,[string]$Session) {
    if($Session -eq 'Conversation'){
        return $CommandLine -match ('(?:^|\s)--resume(?:=|\s+)"?'+[regex]::Escape($script:ClaudeConversationSessionId)+'"?(?:\s|$)')
    }
    return $CommandLine -match '(?:^|\s)--name(?:=|\s+)"?雑談Haiku"?(?:\s|$)'
}

function Publish-ClaudeMobileConnection {
    param(
        [string]$SessionDirectory,
        [int]$ProcessId,
        [string]$ProcessStartFileTime,
        [string]$ExpectedSessionId,
        [string]$OutputPath,
        [string]$LaunchStatus
    )
    $recordPath=Join-Path $SessionDirectory ($ProcessId.ToString()+'.json')
    if(-not (Test-Path -LiteralPath $recordPath)){return $null}
    try {$record=Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8|ConvertFrom-Json}
    catch {return $null}
    if($record.pid -ne $ProcessId -or $record.sessionId -ne $ExpectedSessionId -or
        [string]$record.procStart -ne $ProcessStartFileTime -or
        $record.bridgeSessionId -notmatch '^session_[A-Za-z0-9]+$'){return $null}

    $value=[ordered]@{}
    if(Test-Path -LiteralPath $OutputPath){
        $prior=Get-Content -LiteralPath $OutputPath -Raw -Encoding UTF8|ConvertFrom-Json
        foreach($property in $prior.PSObject.Properties){$value[$property.Name]=$property.Value}
    }
    $url='https://claude.ai/code/'+$record.bridgeSessionId
    if($value.Contains('url') -and $value['url'] -ne $url){$value['previousUrl']=$value['url']}
    if($value.Contains('pid') -and $value['pid'] -ne $ProcessId){$value['priorPid']=$value['pid']}
    $value['pid']=$ProcessId
    $value['localSessionId']=$record.sessionId
    $value['bridgeSessionId']=$record.bridgeSessionId
    $value['url']=$url
    $value['workspace']=$record.cwd
    $value['createdAt']=$record.startedAt
    $value['terminalSession']=$null
    $value['source']='interactive-session-metadata'
    $value['observedConnection']='remote-session-recorded'
    $value['stop']='Ctrl+C in the matching Claude console; do not kill unrelated Claude processes'
    $value['latestCheck']=[ordered]@{
        at=[DateTimeOffset]::Now.ToString('o')
        state='remote-session-recorded'
        launchStatus=$LaunchStatus
        sameLocalSession=$true
        phoneRoundTripAfterRecovery='not-yet-confirmed'
    }
    $directory=Split-Path -Parent $OutputPath
    $null=New-Item -ItemType Directory -Path $directory -Force
    $temporary=$OutputPath+'.'+[Guid]::NewGuid().ToString()+'.tmp'
    try {
        [IO.File]::WriteAllText($temporary,($value|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
    } finally {
        if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary}
    }
    [pscustomobject]@{pid=$ProcessId;localSessionId=$record.sessionId;bridgeSessionId=$record.bridgeSessionId;url=$url}
}
