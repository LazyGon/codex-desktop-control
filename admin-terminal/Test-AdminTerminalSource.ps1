$ErrorActionPreference='Stop'
$errors=@()
foreach($file in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File)){
    $tokens=$null;$parseErrors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$parseErrors)
    $errors+=@($parseErrors)
}
if($errors.Count){$errors | ForEach-Object {$_.Message};exit 1}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('codex-admin-event-test-'+[Guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
$watcher=[IO.FileSystemWatcher]::new($temp,'*.json')
$source='CodexAdminTest.'+[Guid]::NewGuid()
$exitSource=$source+'.Exit'
$observer=$null;$child=$null
try {
    Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier $source | Out-Null
    $watcher.EnableRaisingEvents=$true
    # Change occurs BEFORE waiting: a regression for the scan/wait race.
    [IO.File]::WriteAllText((Join-Path $temp 'event.json'),'{}')
    $event=Wait-Event -SourceIdentifier $source -Timeout 10
    if(-not $event){throw 'Previously registered filesystem event was lost.'}
    . (Join-Path $PSScriptRoot 'ProcessExitObserver.ps1')
    $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command "exit 0"' -WindowStyle Hidden -PassThru
    $null=$child.Handle
    $observer=[CodexAdmin.ProcessExitObserver]::new($child.Id)
    Register-ObjectEvent -InputObject $observer -EventName Exited -SourceIdentifier $exitSource | Out-Null
    $observer.Start()
    if(-not (Wait-Event -SourceIdentifier $exitSource -Timeout 10)){throw 'OS process-exit notification was not delivered.'}
    if(-not $observer.HasExited){throw 'OS process-exit wait did not signal.'}
    'PASS: Windows PowerShell source parses; filesystem and read-only OS process-exit events are delivered.'
} finally {
    Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue | Remove-Event
    Unregister-Event -SourceIdentifier $exitSource -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $exitSource -ErrorAction SilentlyContinue | Remove-Event
    if($observer){$observer.Dispose()};if($child){$child.WaitForExit();$child.Dispose()}
    $watcher.Dispose()
    Remove-Item -LiteralPath (Join-Path $temp 'event.json') -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temp
}
