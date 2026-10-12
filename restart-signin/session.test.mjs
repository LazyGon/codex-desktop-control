import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decideIdle } from './session.mjs';
const base={own:{cwd:'C:/test',status:{type:'idle'}},otherActive:[],activeTurn:null};
test('wait for exact own active turn',()=>assert.equal(decideIdle({...base,activeTurn:{id:'exact'}},'C:/test'),'wait-own-idle'));
test('never close other active tasks',()=>assert.throws(()=>decideIdle({...base,otherActive:['other']},'C:/test'),/Other tasks/));
test('wrong workspace fails closed',()=>assert.throws(()=>decideIdle(base,'C:/wrong'),/workspace/));
test('idle owner with no other work is ready',()=>assert.equal(decideIdle(base,'C:/test'),'ready'));
test('native restart only selects restart + ARSO without forced closure or application restart',()=>{
  const source=fs.readFileSync(new URL('./NativeRestart.cs',import.meta.url),'utf8');
  const flags=Number(source.match(/Flags = (0x[0-9A-F]+);/)[1]);
  assert.equal(flags,0x2004);assert.equal(flags&0x1,0);assert.equal(flags&0x2,0);assert.equal(flags&0x80,0);assert.equal(flags&0x40,0);
  assert.match(source,/InitiateShutdownW\(null,null,0,Flags,Reason\)/);
});
test('inspection returns before native restart dispatch and setting mutation',()=>{
  const source=fs.readFileSync(new URL('./Invoke-RestartSignIn.ps1',import.meta.url),'utf8');
  assert.ok(source.indexOf("$Mode -eq 'Inspect'")<source.indexOf("$key.SetValue('OptOut'"));
  assert.ok(source.indexOf('return\n}')<source.indexOf('RequestOneRestart()'));
  assert.match(source,/restartAuthorized -ne \$true/);assert.match(source,/phase -ne 'prepared'/);
});
