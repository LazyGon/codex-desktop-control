import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AutomationStore,
  parseAutomationToml,
  serializeAutomationToml,
} from '../src/automation-store.mjs';

function temporaryStore(context, options = {}) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-automation-store-'));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  return {
    codexHome,
    store: new AutomationStore({
      codexHome,
      now: () => options.now ?? 1_000,
      idFactory: () => options.id ?? 'automation-test',
    }),
  };
}

test('heartbeat create defaults to the calling thread and round-trips UTF-8', (context) => {
  const { codexHome, store } = temporaryStore(context);
  const created = store.execute({
    mode: 'create',
    kind: 'heartbeat',
    name: '動画アップロード監視',
    prompt: '進捗を確認する。\n削除はしない。',
    rrule: 'FREQ=MINUTELY;INTERVAL=30',
    status: 'ACTIVE',
    destination: 'thread',
  }, { threadId: 'thread-123' });

  assert.deepEqual(created.automation, {
    id: 'automation-test',
    kind: 'heartbeat',
    name: '動画アップロード監視',
    prompt: '進捗を確認する。\n削除はしない。',
    rrule: 'FREQ=MINUTELY;INTERVAL=30',
    status: 'ACTIVE',
    notificationPolicy: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    destination: 'thread',
    targetThreadId: 'thread-123',
  });

  const filePath = path.join(codexHome, 'automations', 'automation-test', 'automation.toml');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /name = "動画アップロード監視"/);
  assert.match(source, /target_thread_id = "thread-123"/);
  assert.deepEqual(store.execute({ mode: 'view', id: 'automation-test' }), created);
});

test('heartbeat update preserves identity and creation time while clearing notification policy', (context) => {
  let timestamp = 1_000;
  const { store } = temporaryStore(context);
  store.now = () => timestamp;
  store.execute({
    mode: 'create',
    kind: 'heartbeat',
    name: 'Monitor',
    prompt: 'Check progress.',
    rrule: 'FREQ=MINUTELY;INTERVAL=10',
    status: 'ACTIVE',
    notificationPolicy: 'failed_runs_only',
  }, { threadId: 'thread-original' });

  timestamp = 2_000;
  const updated = store.execute({
    mode: 'update',
    id: 'automation-test',
    kind: 'heartbeat',
    name: 'Monitor',
    prompt: 'Check progress.',
    rrule: 'FREQ=MINUTELY;INTERVAL=30',
    status: 'PAUSED',
    notificationPolicy: null,
    targetThreadId: 'thread-new',
  }, { threadId: 'thread-calling' });

  assert.equal(updated.automation.id, 'automation-test');
  assert.equal(updated.automation.createdAt, 1_000);
  assert.equal(updated.automation.updatedAt, 2_000);
  assert.equal(updated.automation.rrule, 'FREQ=MINUTELY;INTERVAL=30');
  assert.equal(updated.automation.status, 'PAUSED');
  assert.equal(updated.automation.notificationPolicy, null);
  assert.equal(updated.automation.targetThreadId, 'thread-new');
});

test('cron resolves a Desktop local project to cwd paths', (context) => {
  const { codexHome, store } = temporaryStore(context, { id: 'cron-test' });
  fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'local-projects': {
      'local-project': {
        id: 'local-project',
        name: 'Project',
        rootPaths: ['C:\\work\\project'],
      },
    },
  }), 'utf8');

  const result = store.execute({
    mode: 'create',
    kind: 'cron',
    name: 'Daily check',
    prompt: 'Run checks.',
    rrule: 'FREQ=DAILY;BYHOUR=9',
    status: 'PAUSED',
    executionEnvironment: 'local',
    destination: 'local',
    projectId: 'local-project',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  });

  assert.equal(result.automation.projectId, 'local-project');
  assert.equal(result.automation.executionEnvironment, 'local');
  const parsed = parseAutomationToml(fs.readFileSync(
    path.join(codexHome, 'automations', 'cron-test', 'automation.toml'),
    'utf8',
  ));
  assert.deepEqual(parsed.cwds, ['C:\\work\\project']);
  assert.equal(parsed.model, 'gpt-5.6-sol');
  assert.equal(parsed.reasoning_effort, 'high');
  assert.deepEqual(store.listProjects(), [{
    projectId: 'local-project',
    hostId: 'local',
    name: 'Project',
    rootPaths: ['C:\\work\\project'],
  }]);
  assert.deepEqual(store.project('local-project'), store.listProjects()[0]);
});

test('delete removes only automation.toml and keeps a non-empty directory', (context) => {
  const { codexHome, store } = temporaryStore(context);
  store.execute({
    mode: 'create',
    kind: 'heartbeat',
    name: 'Monitor',
    prompt: 'Check.',
    rrule: 'FREQ=HOURLY',
    status: 'ACTIVE',
  }, { threadId: 'thread-1' });
  const directory = path.join(codexHome, 'automations', 'automation-test');
  const preservedPath = path.join(directory, 'preserve.txt');
  fs.writeFileSync(preservedPath, 'keep', 'utf8');

  assert.deepEqual(store.execute({ mode: 'delete', id: 'automation-test' }), {
    deleted: true,
    id: 'automation-test',
  });
  assert.equal(fs.existsSync(path.join(directory, 'automation.toml')), false);
  assert.equal(fs.readFileSync(preservedPath, 'utf8'), 'keep');
});

test('unsafe ids and suggested mutations fail closed', (context) => {
  const { store } = temporaryStore(context);
  assert.throws(
    () => store.execute({ mode: 'view', id: '..\\outside' }),
    /Automation id/,
  );
  assert.throws(
    () => store.execute({ mode: 'suggested_create' }),
    /requires confirmation/,
  );
  assert.throws(
    () => store.execute({ mode: 'suggested_update' }),
    /requires confirmation/,
  );
});

test('automation TOML serializer escapes strings and parses its output', () => {
  const automation = {
    version: 1,
    id: 'round-trip',
    kind: 'heartbeat',
    name: 'Quoted "name"',
    prompt: 'C:\\work\\file\nnext',
    status: 'ACTIVE',
    rrule: 'FREQ=HOURLY',
    target_thread_id: 'thread',
    created_at: 1,
    updated_at: 2,
  };
  assert.deepEqual(parseAutomationToml(serializeAutomationToml(automation)), automation);
});
