import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideIdle } from './session.mjs';
const base={own:{cwd:'C:/test',status:{type:'idle'}},otherActive:[],activeTurn:null};
test('wait for exact own active turn',()=>assert.equal(decideIdle({...base,activeTurn:{id:'exact'}},'C:/test'),'wait-own-idle'));
test('never close other active tasks',()=>assert.throws(()=>decideIdle({...base,otherActive:['other']},'C:/test'),/Other tasks/));
test('wrong workspace fails closed',()=>assert.throws(()=>decideIdle(base,'C:/wrong'),/workspace/));
test('idle owner with no other work is ready',()=>assert.equal(decideIdle(base,'C:/test'),'ready'));
test('native restart exposes only restart and ARSO flags', context=>{
  if(process.platform!=='win32'){context.skip('Windows PowerShell and WinSDK flags');return;}
  const source=fileURLToPath(new URL('./NativeRestart.cs',import.meta.url)).replaceAll("'", "''");
  const command=`Add-Type -Path '${source}'; [CodexRestartSignIn.NativeRestart]::Flags`;
  const shell=path.join(process.env.WINDIR??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const flags=Number(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',timeout:20000}).trim());
  assert.equal(flags,0x2004);
});
