import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
test('native helper compiles and refuses a mismatched process identity before requesting shutdown',()=>{
 const helper=path.join(root,'CodexDesktopShutdown.ps1').replaceAll("'","''");
 const output=execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; . '${helper}'; $p=Get-Process -Id $PID; try{Invoke-CodexDesktopNormalShutdown -ProcessId $PID -ExpectedExecutable $p.Path -ExpectedStartTimeUtc '2000-01-01T00:00:00Z' -Execute; 'unexpected'}catch{if($_.Exception.ToString() -notmatch 'identity changed'){throw};'rejected'}; if(!(Get-Process -Id $PID)){throw 'Test process was not preserved.'}`],{encoding:'utf8'}).trim();
 assert.equal(output,'rejected');
});
