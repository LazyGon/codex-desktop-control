import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskChannelCreateJournal } from '../src/task-channel-create-journal.mjs';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-channel-journal-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, journal: new TaskChannelCreateJournal(directory),
    scope: { threadId:'thread-001',guildId:'123456789',categoryId:'987654321' } };
}

test('channel creation is persisted before dispatch and concurrent callers join one request', async context => {
  const {journal,scope} = fixture(context);
  const gate = Promise.withResolvers();
  let calls=0;
  const operation=()=>{calls++;assert.equal(journal.read(scope.threadId).phase,'dispatching');return gate.promise;};
  const first=journal.create(scope,operation);
  const second=journal.create(scope,operation);
  assert.equal(calls,1);
  gate.resolve({id:'channel-1'});
  assert.deepEqual(await Promise.all([first,second]),[{id:'channel-1'},{id:'channel-1'}]);
  assert.equal(journal.read(scope.threadId).phase,'confirmed');
  await assert.rejects(journal.create(scope,operation),/CHANNEL_CREATE_RESULT_UNRESOLVED/);
  assert.equal(calls,1);
});

test('failed and imported unknown creates never replay across process instances', async context => {
  const {journal,scope,directory}=fixture(context);
  await assert.rejects(journal.create(scope,()=>{throw Object.assign(new Error('SECRET_RESPONSE'),{status:403,code:50013});}),/CHANNEL_CREATE_RESULT_UNKNOWN/);
  const saved=journal.read(scope.threadId);
  assert.equal(saved.phase,'unknown');assert.equal(saved.httpStatus,403);
  assert.doesNotMatch(fs.readFileSync(journal.recordPath(scope.threadId),'utf8'),/SECRET_RESPONSE/);
  let calls=0;
  await assert.rejects(new TaskChannelCreateJournal(directory).create(scope,()=>{calls++;}),/UNRESOLVED/);
  assert.equal(calls,0);
  const imported={...scope,threadId:'thread-002'};
  journal.importUnknown(imported,{oldBridgePid:25036});
  await assert.rejects(journal.create(imported,()=>{calls++;}),/UNRESOLVED/);
  assert.equal(calls,0);
});

test('an explicit closed-actor and authoritative-absence recovery retains unknown history', async context => {
  const {journal,scope,directory}=fixture(context);
  journal.importUnknown(scope,{oldBridgePid:25036});
  assert.throws(()=>journal.reconcileAbsent(scope.threadId,{actorExited:true,matchingChannelCount:0}),/RECONCILIATION_REQUIRED/);
  const proof={actorExited:true,matchingChannelCount:0,authorizationRef:'owner-request',channelReadEvidenceSha256:'a'.repeat(64),closedActorEvidenceSha256:'b'.repeat(64)};
  journal.reconcileAbsent(scope.threadId,proof);
  const channel=await journal.create(scope,async()=>({id:'recovered-channel'}));
  assert.equal(channel.id,'recovered-channel');
  const history=fs.readdirSync(directory).filter(file=>file.endsWith('.event.json')).map(file=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8')));
  assert.ok(history.some(record=>record.phase==='unknown'));
  assert.ok(history.some(record=>record.phase==='reconciledAbsent'));
  assert.equal(journal.read(scope.threadId).previousAttemptId,history.find(record=>record.phase==='unknown').attemptId);
});

test('scope conflicts, retained crash locks and invalid records fail closed', async context => {
  const {journal,scope}=fixture(context);
  journal.importUnknown(scope,{});
  await assert.rejects(journal.create({...scope,guildId:'999'},async()=>({id:'wrong'})),/UNRESOLVED/);
  const other={...scope,threadId:'thread-003'};
  fs.writeFileSync(`${journal.recordPath(other.threadId)}.lock`,'crash');
  await assert.rejects(journal.create(other,async()=>({id:'wrong'})),/LOCKED/);
  assert.throws(()=>journal.recordPath('../escape'),/INVALID/);
});
