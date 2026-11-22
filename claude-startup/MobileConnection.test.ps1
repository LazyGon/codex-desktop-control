$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Session.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('claude-mobile-'+[Guid]::NewGuid().ToString())
$null=New-Item -ItemType Directory -Path $temporary
$output=Join-Path $temporary 'mobile.json'
$localId='00000000-0000-4000-8000-000000000001'
try {
    @{url='https://claude.ai/code/session_previous';pid=5;retainedPreference='keep'}|ConvertTo-Json|Set-Content -LiteralPath $output -Encoding UTF8
    $native=@{pid=101;sessionId=$localId;procStart='1001';bridgeSessionId='session_nativeA';cwd='C:\fixture';startedAt='2026-01-01T00:00:00Z'}
    $native|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $temporary '101.json') -Encoding UTF8
    $first=Publish-ClaudeMobileConnection $temporary 101 '1001' $localId $output 'heartbeat-confirmed'
    $saved=Get-Content -LiteralPath $output -Raw -Encoding UTF8|ConvertFrom-Json
    if($first.url -ne 'https://claude.ai/code/session_nativeA' -or $saved.url -ne $first.url -or
        $saved.previousUrl -ne 'https://claude.ai/code/session_previous' -or $saved.retainedPreference -ne 'keep'){
        throw 'The current remote URL was not published while preserving existing settings.'
    }
    $native.pid=102;$native.procStart='2002';$native.bridgeSessionId='session_nativeB'
    $native|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $temporary '102.json') -Encoding UTF8
    $second=Publish-ClaudeMobileConnection $temporary 102 '2002' $localId $output 'already-running'
    $saved=Get-Content -LiteralPath $output -Raw -Encoding UTF8|ConvertFrom-Json
    if($second.url -ne 'https://claude.ai/code/session_nativeB' -or $saved.previousUrl -ne 'https://claude.ai/code/session_nativeA' -or
        $saved.localSessionId -ne $localId -or $saved.pid -ne 102 -or $saved.terminalSession -ne $null){
        throw 'A restarted local conversation retained its obsolete mobile URL or process identity.'
    }
    foreach($bad in @(
        @{pid=999;sessionId=$localId;procStart='2002';bridgeSessionId='session_wrongPid'},
        @{pid=102;sessionId='different-conversation';procStart='2002';bridgeSessionId='session_wrongConversation'},
        @{pid=102;sessionId=$localId;procStart='1001';bridgeSessionId='session_reusedPid'},
        @{pid=102;sessionId=$localId;procStart='2002';bridgeSessionId='cse_internalOnly'}
    )){
        @{url='https://claude.ai/code/session_keep';retainedPreference='untouched'}|ConvertTo-Json|Set-Content -LiteralPath $output -Encoding UTF8
        $bad|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $temporary '102.json') -Encoding UTF8
        $rejected=Publish-ClaudeMobileConnection $temporary 102 '2002' $localId $output 'already-running'
        $saved=Get-Content -LiteralPath $output -Raw -Encoding UTF8|ConvertFrom-Json
        if($null -ne $rejected -or $saved.url -ne 'https://claude.ai/code/session_keep' -or $saved.retainedPreference -ne 'untouched'){
            throw 'A mismatched native session replaced the known connection.'
        }
    }
    $missing=Join-Path $temporary 'not-created.json'
    if($null -ne (Publish-ClaudeMobileConnection $temporary 404 '4040' $localId $missing 'starting') -or (Test-Path $missing)){
        throw 'An uninitialized native session produced a false connection record.'
    }
    'Mobile connection publication: 7 passed'
} finally {
    $parent=[IO.Path]::GetFullPath((Split-Path -Parent $temporary)).TrimEnd('\')
    if($parent -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')){throw 'Unexpected test cleanup path.'}
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
