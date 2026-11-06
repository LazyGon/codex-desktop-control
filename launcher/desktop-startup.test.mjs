import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
const root=path.dirname(fileURLToPath(import.meta.url));
const literal=v=>`'${v.replaceAll("'","''")}'`;
function run(script){return execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; . ${literal(path.join(root,'CodexDesktopStartup.ps1'))}; ${script}`],{encoding:'utf8'}).trim()}
test('Desktop receives an explicit endpoint without Explorer or permanent setting changes',()=>{
 const value=JSON.parse(run("$env:CODEX_APP_SERVER_FORCE_CLI='1'; $env:CODEX_APP_SERVER_USE_LOCAL_DAEMON='1'; $env:CODEX_APP_SERVER_WS_URL='ws://127.0.0.1:1'; $i=New-CodexDesktopStartInfo -DesktopExecutable 'C:\\fixture\\ChatGPT.exe' -WebSocketUrl 'ws://127.0.0.1:8798'; @{exe=$i.FileName;shell=$i.UseShellExecute;endpoint=$i.EnvironmentVariables['CODEX_APP_SERVER_WS_URL'];force=$i.EnvironmentVariables.ContainsKey('CODEX_APP_SERVER_FORCE_CLI');daemon=$i.EnvironmentVariables.ContainsKey('CODEX_APP_SERVER_USE_LOCAL_DAEMON');parentEndpoint=$env:CODEX_APP_SERVER_WS_URL}|ConvertTo-Json"));
 assert.equal(value.shell,false);assert.equal(value.endpoint,'ws://127.0.0.1:8798');assert.equal(value.force,false);assert.equal(value.daemon,false);assert.equal(value.parentEndpoint,'ws://127.0.0.1:1');
});
test('normal startup enables Chrome compatibility only on the verified Desktop build',()=>{
 const value=JSON.parse(run("$env:CODEX_APP_SERVER_USE_LOCAL_DAEMON='parent'; $builds=@('26.1027.3384.0','26.1029.7803.0','26.1030.1.0'); $starts=@(foreach($version in $builds){$i=New-CodexDesktopStartInfo -DesktopExecutable 'C:\\fixture\\ChatGPT.exe' -WebSocketUrl 'ws://127.0.0.1:8798' -PackageVersion $version; @{endpoint=$i.EnvironmentVariables['CODEX_APP_SERVER_WS_URL'];compatibility=$i.EnvironmentVariables['CODEX_APP_SERVER_USE_LOCAL_DAEMON']}}); @{starts=$starts;parent=$env:CODEX_APP_SERVER_USE_LOCAL_DAEMON}|ConvertTo-Json -Depth 4"));
 assert.deepEqual(value,{starts:[null,'1',null].map(compatibility=>({endpoint:'ws://127.0.0.1:8798',compatibility})),parent:'parent'});
});
test('an explicitly requested browser access trial still rejects an unverified build',()=>{
 assert.equal(run("try{New-CodexDesktopStartInfo -DesktopExecutable 'C:\\fixture\\ChatGPT.exe' -WebSocketUrl 'ws://127.0.0.1:8798' -PackageVersion '26.1030.1.0' -DesktopBrowserAccessTrial;'unexpected'}catch{'rejected'}"),'rejected');
});
test('a healthy cold startup is not failed just because thirty seconds elapsed',()=>{
 assert.equal(run('Get-CodexDesktopConnectionDecision -ServerAlive $true -DesktopAlive $true -Connected $false -Cancelled $false -ElapsedSeconds 120'),'pending');
 assert.equal(run('Get-CodexDesktopConnectionDecision -ServerAlive $true -DesktopAlive $true -Connected $true -Cancelled $false -ElapsedSeconds 120'),'ready');
});
test('default startup has no agent deadline; an explicit inactivity limit is honored',()=>{
 assert.equal(run('Get-CodexDesktopConnectionDecision -ServerAlive $true -DesktopAlive $true -ElapsedSeconds 86400'),'pending');
 assert.equal(run("try{Get-CodexDesktopConnectionDecision -ServerAlive $true -DesktopAlive $true -TimeoutSeconds 180 -ElapsedSeconds 180;'unexpected'}catch{'rejected'}"),'rejected');
});
test('only forward startup stages count; reconnect errors and unrelated hosts do not',()=>{
 const stages=JSON.parse(run("@((Get-CodexDesktopStartupLogStage -Line 'info [AppServerConnection] Starting app-server connection hostId=local transport=websocket'),(Get-CodexDesktopStartupLogStage -Line 'error [AppServerConnection] websocket_error hostId=local'),(Get-CodexDesktopStartupLogStage -Line 'info [AppServerConnection] Transport start success connectionId=1 hostId=local transport=websocket'),(Get-CodexDesktopStartupLogStage -Line 'info [AppServerConnection] Starting app-server connection hostId=durable transport=websocket'))|ConvertTo-Json"));
 assert.deepEqual(stages,[20,0,30,0]);
});
test('progress reader follows the current date and exact PID, advances once, and excludes stale/cloud events',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'codex-progress-'));
 try{
  const created=new Date(Date.now()-1000), stamp=new Date().toISOString();
  const days=[`${created.getFullYear()}/${String(created.getMonth()+1).padStart(2,'0')}/${String(created.getDate()).padStart(2,'0')}`,created.toISOString().slice(0,10).replaceAll('-','/')];
  const dir=path.join(temporary,'Codex','Logs',days[0]);fs.mkdirSync(dir,{recursive:true});
  const log=path.join(dir,'codex-desktop-fixture-12345-t0-0.log');
  fs.writeFileSync(log,`2000-01-01T00:00:00Z info [AppServerConnection] app_server_connection.state_changed initialized=true next=connected hostId=local\n${stamp} info [AppServerConnection] Starting app-server connection hostId=local transport=websocket\n${stamp} info [AppServerConnection] initialize_handshake_result outcome=success hostId=durable transportKind=websocket\n`);
  const value=JSON.parse(run(`$env:LOCALAPPDATA=${literal(temporary)}; $roots=@([pscustomobject]@{ProcessId=12345;CreationDate=${literal(created.toISOString())}}); $offsets=@{}; $package=[pscustomobject]@{PackageFamilyName='fixture'}; $a=Read-CodexDesktopStartupProgress $roots $offsets $package; $b=Read-CodexDesktopStartupProgress $roots $offsets $package; [IO.File]::AppendAllText(${literal(log)},${literal(stamp+' info [AppServerConnection] Transport start success hostId=local transport=websocket\n')}); $c=Read-CodexDesktopStartupProgress $roots $offsets $package; @($a,$b,$c)|ConvertTo-Json`));
  assert.deepEqual(value,[20,0,30]);
 }finally{fs.rmSync(temporary,{recursive:true,force:true})}
});
test('exited processes, explicit cancellation and explicitly chosen deadlines fail closed',()=>{
 for(const args of ['-ServerAlive $false -DesktopAlive $true','-ServerAlive $true -DesktopAlive $false','-ServerAlive $true -DesktopAlive $true -Cancelled $true','-ServerAlive $true -DesktopAlive $true -TimeoutSeconds 30']){
  assert.equal(run(`try{Get-CodexDesktopConnectionDecision ${args} -ElapsedSeconds 120; 'unexpected'}catch{'rejected'}`),'rejected');
 }
 assert.equal(run("try{New-CodexDesktopStartInfo -DesktopExecutable 'C:\\fixture\\ChatGPT.exe' -WebSocketUrl 'ws://192.168.1.1:8798';'unexpected'}catch{'rejected'}"),'rejected');
});

test('startup requires both a WebSocket handshake and local initialization from the same Desktop process', () => {
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'codex-startup-handshake-'));
 try {
  const created=new Date(Date.now()-1000), stamp=new Date().toISOString();
  const day=[created.getFullYear(),String(created.getMonth()+1).padStart(2,'0'),String(created.getDate()).padStart(2,'0')].join('/');
  const dir=path.join(temporary,'Codex','Logs',day);
  fs.mkdirSync(dir,{recursive:true});
  const first=path.join(dir,'codex-desktop-fixture-101-t0-0.log');
  const other=path.join(dir,'codex-desktop-fixture-202-t0-0.log');
  const ws=stamp+' info [AppServerConnection] initialize_handshake_result outcome=success transportKind=websocket\n';
  const local=stamp+' info [AppServerConnection] app_server_connection.state_changed hostId=local initialized=true next=connected pendingClientRequests=0\n';
  fs.writeFileSync(first,ws);
  fs.writeFileSync(other,local);
  const result=JSON.parse(run([
   `$env:LOCALAPPDATA=${literal(temporary)}`,
   `$created=[DateTimeOffset]${literal(created.toISOString())}`,
   '$roots=@([pscustomobject]@{ProcessId=101;CreationDate=$created},[pscustomobject]@{ProcessId=202;CreationDate=$created})',
   "$package=[pscustomobject]@{PackageFamilyName='fixture'}; $offsets=@{}; $states=@{}",
   '$null=Read-CodexDesktopStartupProgress $roots $offsets $package -SharedHandshakeByDesktop $states',
   "$before=($states.Values -contains 'local-connected')",
   `[IO.File]::AppendAllText(${literal(first)},${literal(local)})`,
   '$null=Read-CodexDesktopStartupProgress $roots $offsets $package -SharedHandshakeByDesktop $states',
   "@($before,($states.Values -contains 'local-connected'))|ConvertTo-Json",
  ].join('; ')));
  assert.deepEqual(result,[false,true]);
 } finally {
  assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));
  fs.rmSync(temporary,{recursive:true,force:true});
 }
});
