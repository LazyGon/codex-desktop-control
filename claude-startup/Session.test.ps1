$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Session.ps1')
$cases=@(
    @('Conversation','claude.exe --resume 5467c555-7279-5b55-b8ce-e262b1e2e1f7 --remote-control',$true),
    @('Conversation','claude.exe --resume="5467c555-7279-5b55-b8ce-e262b1e2e1f7"',$true),
    @('Conversation','claude.exe --resume 5467c555-7279-5b55-b8ce-e262b1e2e1f70',$false),
    @('Conversation','claude.exe --name 5467c555-7279-5b55-b8ce-e262b1e2e1f7',$false),
    @('Haiku','claude.exe --name 雑談Haiku --remote-control 雑談Haiku',$true),
    @('Haiku','claude.exe --name="雑談Haiku"',$true),
    @('Haiku','claude.exe --name 雑談Haiku2',$false),
    @('Haiku','claude.exe --remote-control 雑談Haiku',$false)
)
foreach($case in $cases){
    if((Test-ClaudeSessionCommand $case[1] $case[0]) -ne $case[2]){throw ('Incorrect duplicate decision: '+$case[1])}
}
'Session duplicate matching: 8 passed'
