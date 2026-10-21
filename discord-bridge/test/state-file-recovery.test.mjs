import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.mjs';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-crash-recovery-'));
  context.after(() => fs.rmSync(directory, {recursive:true,force:true}));
  const store = new StateStore(directory, 'guild-1');
  store.setBinding('task-1', {channelId:'channel-1',watchLevel:'quiet',completionReportsEnabled:false});
  store.setInfrastructure({controlChannelId:'control-1'});
  return { directory, file:path.join(directory,'state.json') };
}

for (const missing of [false,true]) {
  test(`restores an existing binding from the saved generation when primary is ${missing?'missing':'zero-filled'}`, context => {
    const {directory,file} = fixture(context);
    if (missing) fs.unlinkSync(file); else fs.writeFileSync(file, Buffer.alloc(256));
    const journal = path.join(directory,'external-operation-unknown.json');
    fs.writeFileSync(journal, '{"phase":"unknown","attemptId":"original-attempt"}');
    const restored = new StateStore(directory,'guild-1');
    assert.equal(restored.binding('task-1').channelId,'channel-1');
    assert.equal(restored.binding('task-1').watchLevel,'quiet');
    assert.equal(restored.binding('task-1').completionReportsEnabled,false);
    assert.equal(fs.readFileSync(journal,'utf8'),'{"phase":"unknown","attemptId":"original-attempt"}');
    if (!missing) {
      const copies=fs.readdirSync(directory).filter(name=>name.startsWith('state.json.corrupt.'));
      assert.equal(copies.length,1);
      assert.deepEqual(fs.readFileSync(path.join(directory,copies[0])),Buffer.alloc(256));
    }
    assert.equal(JSON.parse(fs.readFileSync(file)).bindings['task-1'].channelId,'channel-1');
  });
}

test('falls back to the older valid generation without adopting corrupt backup data', context => {
  const {directory,file}=fixture(context);
  const store=new StateStore(directory,'guild-1');
  store.setBinding('task-2',{channelId:'channel-2'});
  fs.writeFileSync(file,'\0');
  fs.writeFileSync(file+'.bak','\0');
  const restored=new StateStore(directory,'guild-1');
  assert.equal(restored.binding('task-1').channelId,'channel-1');
  assert.equal(restored.binding('task-2'),null);
});

test('does not replace a readable foreign guild or unsupported primary with a stale backup', context => {
  const {directory,file}=fixture(context);
  for (const value of [{guildId:'guild-2',schemaVersion:8},{guildId:'guild-1',schemaVersion:9}]) {
    const original=JSON.stringify(value);
    fs.writeFileSync(file,original);
    assert.throws(()=>new StateStore(directory,'guild-1'),/refusing to reset/);
    assert.equal(fs.readFileSync(file,'utf8'),original);
  }
});

test('skips a structurally unusable checkpoint and retains the older binding', context => {
  const {directory,file}=fixture(context);
  const store=new StateStore(directory,'guild-1');
  store.setBinding('task-2',{channelId:'channel-2'});
  fs.writeFileSync(file,'\0');
  fs.writeFileSync(file+'.bak','{"guildId":"guild-1","schemaVersion":8,"bindings":null,"infrastructure":{}}');
  assert.equal(new StateStore(directory,'guild-1').binding('task-1').channelId,'channel-1');
});

test('rejects foreign and unsupported checkpoints and preserves the corrupt primary', context => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-invalid-checkpoints-'));
  context.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'state.json');
  fs.writeFileSync(file,'\0');
  fs.writeFileSync(file+'.bak','{"guildId":"foreign","schemaVersion":8}');
  fs.writeFileSync(file+'.bak.older','{"guildId":"guild-1","schemaVersion":9}');
  assert.throws(()=>new StateStore(directory,'guild-1'),/refusing to reset/);
  assert.equal(fs.readFileSync(file,'utf8'),'\0');
});
