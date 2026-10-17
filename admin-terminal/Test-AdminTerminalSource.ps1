$ErrorActionPreference='Stop'
$errors=@()
foreach($file in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File)){
    $tokens=$null;$parseErrors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$parseErrors)
    $errors+=@($parseErrors)
}
if($errors.Count){$errors | ForEach-Object {$_.Message};exit 1}
$exitSource='CodexAdminTest.'+[Guid]::NewGuid()+'.Exit'
$observer=$null;$child=$null
try {
    . (Join-Path $PSScriptRoot 'ProcessExitObserver.ps1')
    $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command "exit 0"' -WindowStyle Hidden -PassThru
    $null=$child.Handle
    $observer=[CodexAdmin.ProcessExitObserver]::new($child.Id)
    Register-ObjectEvent -InputObject $observer -EventName Exited -SourceIdentifier $exitSource | Out-Null
    $observer.Start()
    if(-not (Wait-Event -SourceIdentifier $exitSource -Timeout 10)){throw 'OS process-exit notification was not delivered.'}
    if(-not $observer.HasExited){throw 'OS process-exit wait did not signal.'}
    'PASS: the read-only process-exit observer delivers an exit event.'
} finally {
    Unregister-Event -SourceIdentifier $exitSource -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $exitSource -ErrorAction SilentlyContinue | Remove-Event
    if($observer){$observer.Dispose()};if($child){$child.WaitForExit();$child.Dispose()}
}
