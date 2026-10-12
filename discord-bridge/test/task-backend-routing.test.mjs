import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBoundTaskOperation, resolveTaskBackend } from '../src/task-backend-routing.mjs';

const threadId = 'api-task';
const durable = { threadId, backend: 'durable', hostId: 'durable' };

test('existing exact bindings keep the shared route', async () => {
  let observed;
  const result = await executeBoundTaskOperation({
    binding: { threadId }, threadId, operation: 'read',
    adapters: { shared: { read(id) { observed = id; return 'shared-result'; } } },
  });
  assert.equal(observed, threadId);
  assert.equal(result, 'shared-result');
});

test('durable operations preserve the target and permission arguments', async () => {
  const permissions = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  const args = [permissions];
  let observed;
  const result = await executeBoundTaskOperation({
    binding: durable, threadId, operation: 'deliver', args,
    adapters: {
      shared: { deliver() { assert.fail('must not touch shared backend'); } },
      durable: { deliver(id, settings) { observed = [id, settings]; return 'accepted'; } },
    },
  });
  assert.equal(result, 'accepted');
  assert.equal(observed[0], threadId);
  assert.equal(observed[1], permissions);
});

test('unavailable or unsupported durable operations never fall back to shared', async () => {
  for (const adapter of [undefined, {}]) {
    await assert.rejects(executeBoundTaskOperation({
      binding: durable, threadId, operation: 'interrupt',
      adapters: {
        shared: { interrupt() { assert.fail('wrong backend'); } },
        durable: adapter,
      },
    }), /durable task backend does not support interrupt/);
  }
});

test('a failed durable request is reported without retrying on another backend', async () => {
  const failure = new Error('permission denied');
  await assert.rejects(executeBoundTaskOperation({
    binding: durable, threadId, operation: 'read',
    adapters: {
      shared: { read() { assert.fail('wrong backend'); } },
      durable: { async read() { throw failure; } },
    },
  }), (error) => error === failure);
});

test('unknown targets and inconsistent backend ownership are rejected', () => {
  for (const binding of [null, { threadId: 'other' }]) {
    assert.throws(() => resolveTaskBackend(binding, threadId), /exact registered/);
  }
  assert.throws(() => resolveTaskBackend({ ...durable, hostId: 'local' }, threadId), /durable host/);
  assert.throws(() => resolveTaskBackend({ threadId, backend: 'shared', hostId: 'durable' }, threadId), /local host/);
  assert.throws(() => resolveTaskBackend({ threadId, backend: 'other' }, threadId), /Unknown/);
});

test('the router cannot dispatch arbitrary adapter functions or start another task', async () => {
  for (const operation of ['constructor', 'toString', 'start', 'exec']) {
    await assert.rejects(executeBoundTaskOperation({
      binding: durable, threadId, operation, adapters: { durable: {} },
    }), /Unsupported task operation/);
  }
});
