import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { workerArguments, deliveryFor, postbootOwnsCompletion, sameActiveGoal } from './one-shot-job.mjs';
import { collectPins } from '../restart-signin/prepare.mjs';

test('public callback runner uses one explicit script/job without per-job UAC or raw shell', () => {
  assert.deepEqual(workerArguments({ workerScript: 'C:/work/worker.ps1' }, 'C:/work/job.json'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:/work/worker.ps1', '-JobPath', 'C:/work/job.json']);
  assert.throws(() => workerArguments({ requireStandardUac: true }, 'job.json'), /common administrator client/);
  assert.equal(deliveryFor('same', { id: 'exact' }, 'ready')[1].expectedTurnId, 'exact');
});

test('all new restart and callback dependencies are published source, not ignored local maintenance jobs', () => {
  const files = ['../restart-signin/prepare.mjs', '../restart-signin/session.mjs', './one-shot-job.mjs'];
  const pins = collectPins(files.map(file => new URL(file, import.meta.url).pathname).map(file =>
    process.platform === 'win32' ? decodeURIComponent(file).replace(/^\/(\w:)/, '$1') : decodeURIComponent(file)));
  assert.ok(pins.every(pin => !/[\\/]state[\\/]windows-maintenance-/.test(pin.file)));
  assert.ok(pins.every(pin => /^[A-F0-9]{64}$/.test(pin.sha256)));
});

test('historical jobs are not rewritten during dependency pin collection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pinned-history-'));
  try {
    const file = path.join(directory, 'history.mjs');
    const bytes = 'export const immutable = true;\n';
    fs.writeFileSync(file, bytes);
    collectPins([file]);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('accepted Windows restart leaves wake-up to the postboot receiver',()=>{
  assert.equal(postbootOwnsCompletion({phase:'restart-request-accepted',apiReturn:0}),true);
  assert.equal(postbootOwnsCompletion({phase:'unknown-do-not-repeat',apiReturn:0}),true);
  assert.equal(postbootOwnsCompletion({phase:'restart-not-accepted',apiReturn:5}),false);
  assert.equal(postbootOwnsCompletion({phase:'unknown-do-not-repeat'}),false);
  assert.equal(postbootOwnsCompletion(null),false);
});

test('a failure before pause may notify only the same still-active goal',()=>{
  const goal={threadId:'owner',objective:'Original task',status:'active',tokenBudget:null,createdAt:10};
  assert.equal(sameActiveGoal({...goal},goal),true);
  for(const changed of [{status:'paused'},{status:'complete'},{objective:'Other task'},{threadId:'other'},{tokenBudget:1},{createdAt:20}])assert.equal(sameActiveGoal({...goal,...changed},goal),false);
  assert.equal(sameActiveGoal(null,goal),false);
});
