import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listAllThreads,
  pauseActiveGoals,
  resumePausedGoals,
  selectDrainStateForUpdate,
  waitForTurnCompletion,
} from './runtime-update-drain.mjs';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const refreshScriptPath = path.join(launcherRoot, 'Refresh-CodexSharedRuntime.ps1');

function windowsPowerShell() {
  return path.join(
    process.env.WINDIR ?? String.raw`C:\Windows`,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function extractPowerShellFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name} {`);
  const end = source.indexOf(`function ${nextName} {`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

class FakeClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async call(method, params) {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }
}

test('listAllThreads follows cursors without losing thread status', async () => {
  const client = new FakeClient((method, params) => {
    assert.equal(method, 'thread/list');
    if (!params.cursor) {
      return { data: [{ id: 'T2', status: { type: 'active' } }], nextCursor: 'NEXT' };
    }
    assert.equal(params.cursor, 'NEXT');
    return { data: [{ id: 'T1', status: 'idle' }], nextCursor: null };
  });

  assert.deepEqual(await listAllThreads(client), [
    { id: 'T2', status: { type: 'active' } },
    { id: 'T1', status: 'idle' },
  ]);
});

test('pauseActiveGoals persists every newly paused goal and preserves pre-paused goals', async () => {
  const goals = new Map([
    ['ACTIVE-GOAL', 'active'],
    ['PAUSED-GOAL', 'paused'],
    ['NO-GOAL', null],
  ]);
  const client = new FakeClient((method, params) => {
    if (method === 'thread/list') {
      return {
        data: [
          { id: 'ACTIVE-GOAL', status: 'active' },
          { id: 'PAUSED-GOAL', status: 'idle' },
          { id: 'NO-GOAL', status: 'idle' },
        ],
        nextCursor: null,
      };
    }
    if (method === 'thread/goal/get') {
      const status = goals.get(params.threadId);
      return { goal: status ? { threadId: params.threadId, status } : null };
    }
    if (method === 'thread/goal/set') {
      assert.equal(params.status, 'paused');
      goals.set(params.threadId, 'paused');
      return { goal: { threadId: params.threadId, status: 'paused' } };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const persisted = [];
  const result = await pauseActiveGoals(
    client,
    { schemaVersion: 1, pausedThreadIds: ['ALREADY-RECORDED'] },
    (state) => persisted.push(structuredClone(state)),
  );

  assert.deepEqual(result.pausedThreadIds, ['ACTIVE-GOAL', 'ALREADY-RECORDED']);
  assert.deepEqual(result.activeThreadIds, ['ACTIVE-GOAL']);
  assert.equal(goals.get('PAUSED-GOAL'), 'paused');
  assert.ok(persisted.some((state) => state.pausedThreadIds.includes('ACTIVE-GOAL')));
  assert.equal(
    client.calls.filter((call) => call.method === 'thread/goal/set').length,
    1,
  );
});

test('resumePausedGoals resumes only goals recorded by this update', async () => {
  const goals = new Map([
    ['PAUSED-BY-UPDATE', 'paused'],
    ['CHANGED-AFTER-PAUSE', 'blocked'],
  ]);
  const client = new FakeClient((method, params) => {
    if (method === 'thread/goal/get') {
      return { goal: { threadId: params.threadId, status: goals.get(params.threadId) } };
    }
    if (method === 'thread/goal/set') {
      assert.equal(params.threadId, 'PAUSED-BY-UPDATE');
      assert.equal(params.status, 'active');
      goals.set(params.threadId, 'active');
      return { goal: { threadId: params.threadId, status: 'active' } };
    }
    throw new Error(`Unexpected method: ${method}`);
  });

  const result = await resumePausedGoals(client, {
    pausedThreadIds: ['PAUSED-BY-UPDATE', 'CHANGED-AFTER-PAUSE'],
  });
  assert.deepEqual(result.resumedThreadIds, ['PAUSED-BY-UPDATE']);
  assert.deepEqual(result.unchangedThreadIds, ['CHANGED-AFTER-PAUSE']);
  assert.equal(goals.get('CHANGED-AFTER-PAUSE'), 'blocked');
});

test('a completed drain from an earlier package update cannot block a later update', () => {
  const completed = {
    phase: 'completed',
    fromVersion: '26.820.7780.0',
    toVersion: '26.820.9563.0',
    pausedThreadIds: [],
  };
  assert.equal(
    selectDrainStateForUpdate(completed, '26.917.9434.0', '26.930.2377.0'),
    null,
  );
  assert.equal(
    selectDrainStateForUpdate(completed, '26.820.7780.0', '26.820.9563.0'),
    completed,
  );
  const interrupted = { ...completed, phase: 'draining', pausedThreadIds: ['GOAL'] };
  assert.equal(
    selectDrainStateForUpdate(interrupted, '26.917.9434.0', '26.930.2377.0'),
    interrupted,
  );
});

test('waitForTurnCompletion closes the notification race using threadId from params', async () => {
  const client = new FakeClient((method) => {
    assert.equal(method, 'thread/turns/list');
    return { data: [{ id: 'TURN', status: 'inProgress' }] };
  });
  client.waitFor = async (predicate) => {
    const notification = {
      method: 'turn/completed',
      params: { threadId: 'THREAD', turn: { id: 'TURN', status: 'completed' } },
    };
    assert.equal(predicate(notification), true);
    return notification;
  };

  const result = await waitForTurnCompletion(client, 'THREAD', 'TURN', 10_000);
  assert.equal(result.status, 'completed');
});

test('waitForTurnCompletion re-reads terminal state after a missed notification', async () => {
  let reads = 0;
  const client = new FakeClient((method) => {
    assert.equal(method, 'thread/turns/list');
    reads += 1;
    return {
      data: [{ id: 'TURN', status: reads === 1 ? 'inProgress' : 'completed' }],
    };
  });
  client.waitFor = async () => {
    throw new Error('Notification wait timed out.');
  };

  const result = await waitForTurnCompletion(client, 'THREAD', 'TURN', 10_000);
  assert.equal(result.status, 'completed');
});

test('Desktop bootstrap stdio helper does not abort a subsequently successful shared connection', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell is required.'); return; }
  const source = fs.readFileSync(path.join(launcherRoot, 'Start-CodexShared.ps1'), 'utf8');
  const waiter = extractPowerShellFunction(source, 'Wait-DesktopSharedConnection', 'Start-DesktopOnRuntime');
  const script = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopStartup.ps1'))}
$script:checks = 0
function Assert-LauncherNotCancelled { }
function Test-DesktopWebSocketConnection { $script:checks += 1; return ($script:checks -ge 3) }
function Get-CodexDesktopRootProcesses { [pscustomobject]@{ ProcessId = 101 } }
function Read-CodexDesktopStartupProgress { return 0 }
function Get-DesktopLocalAppServers { [pscustomobject]@{ ProcessId = 202 } }
function Write-LauncherLog { }
${waiter}
$ok = Wait-DesktopSharedConnection -PackageInfo ([pscustomobject]@{DesktopExecutable='fixture'}) -PortNumber 8798 -OwnedServerProcessId $PID -TimeoutSeconds 1 -PollMilliseconds 1
[pscustomobject]@{ok=$ok} | ConvertTo-Json -Compress
`;
  const output = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], { encoding: 'utf8' });
  assert.equal(JSON.parse(output.trim()).ok, true);
});

test('Desktop connection wait remains cancellable before a shared connection exists', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell is required.'); return; }
  const source = fs.readFileSync(path.join(launcherRoot, 'Start-CodexShared.ps1'), 'utf8');
  const waiter = extractPowerShellFunction(source, 'Wait-DesktopSharedConnection', 'Start-DesktopOnRuntime');
  const script = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopStartup.ps1'))}
$script:checks = 0
function Assert-LauncherNotCancelled { if ($script:checks -ge 1) { throw [OperationCanceledException]::new('fixture cancellation') } }
function Test-DesktopWebSocketConnection { $script:checks += 1; return $false }
function Get-CodexDesktopRootProcesses { [pscustomobject]@{ ProcessId = 101 } }
function Read-CodexDesktopStartupProgress { return 0 }
function Get-DesktopLocalAppServers { }
function Write-LauncherLog { }
${waiter}
try {
  $null = Wait-DesktopSharedConnection -PackageInfo ([pscustomobject]@{DesktopExecutable='fixture'}) -PortNumber 8798 -OwnedServerProcessId $PID -TimeoutSeconds 10 -PollMilliseconds 1
  throw 'Cancellation was ignored.'
} catch [OperationCanceledException] {
  [pscustomobject]@{cancelled=$true} | ConvertTo-Json -Compress
}
`;
  const output = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], { encoding: 'utf8' });
  assert.equal(JSON.parse(output.trim()).cancelled, true);
});

test('request receipts replace the prior run atomically in Windows PowerShell 5.1', {
  skip: process.platform !== 'win32',
}, () => {
  const source = fs.readFileSync(refreshScriptPath, 'utf8');
  const writeFunction = extractPowerShellFunction(
    source,
    'Write-RefreshResult',
    'Get-OptionalObjectProperty',
  );

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-receipt-'));
  const receiptPath = path.join(temporaryRoot, 'receipt.json');
  fs.writeFileSync(receiptPath, '{"requestId":"old","phase":"completed"}\n', 'utf8');
  try {
    const harness = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$resultPath = ${quotePowerShell(receiptPath)}`,
      writeFunction,
      "Write-RefreshResult -Result ([ordered]@{ requestId = 'new'; phase = 'armed' })",
      'Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8',
    ].join('\n');
    const output = execFileSync(windowsPowerShell(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedPowerShell(harness),
    ], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output.replace(/^\uFEFF/, '')), {
      requestId: 'new',
      phase: 'armed',
    });
    assert.deepEqual(
      fs.readdirSync(temporaryRoot),
      ['receipt.json'],
      'the atomic writer must not leave a temporary receipt',
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('refresh task ownership rejects foreign actions, principals, triggers and active tasks', {
  skip: process.platform !== 'win32',
}, () => {
  const source = fs.readFileSync(refreshScriptPath, 'utf8');
  const ownershipFunction = extractPowerShellFunction(source, 'Assert-OwnedRefreshTask', 'Assert-NoUnresolvedRefreshReceipt');
  const taskName = 'Codex Refresh Fixture';
  const repositoryRoot = path.dirname(launcherRoot);
  const command = [
    "& '" + refreshScriptPath.replaceAll("'", "''") + "'",
    "-WaitForThreadId '00000000-0000-0000-0000-000000000001'",
    "-WaitForTurnId '00000000-0000-0000-0000-000000000002'",
    "-FromVersion '26.820.1.0' -ToVersion '26.820.2.0'",
    '-TurnTimeoutSeconds 1800 -RestartTimeoutSeconds 240 -DesktopCloseTimeoutSeconds 120',
    "-ScheduledController -RefreshRequestId '00000000-0000-0000-0000-000000000003'",
    "-ScheduledTaskName '" + taskName + "'",
  ].join(' ');
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ScheduledTaskName=" + quotePowerShell(taskName),
    "$repositoryRoot=" + quotePowerShell(repositoryRoot),
    "$refreshScriptPath=" + quotePowerShell(refreshScriptPath),
    "$scheduledTaskDescription='One-shot controller for a safe shared Codex runtime refresh.'",
    ownershipFunction,
    "$payload=" + quotePowerShell(encodedPowerShell(command)),
    "$task=[pscustomobject]@{ State='Ready'; Description=$scheduledTaskDescription; Principal=[pscustomobject]@{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name}; Triggers=@(); Actions=@([pscustomobject]@{Execute=" + quotePowerShell(windowsPowerShell()) + ";Arguments=('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand '+$payload);WorkingDirectory=$repositoryRoot}) }",
    'Assert-OwnedRefreshTask $task',
    '$rejected=@()',
    "foreach($kind in @('action','principal','trigger','state','directory')) {",
    ' $foreign=$task | ConvertTo-Json -Depth 5 | ConvertFrom-Json',
    " switch($kind) { action {$foreign.Actions[0].Arguments='-Command exit'} principal {$foreign.Principal.UserId='S-1-5-18'} trigger {$foreign.Triggers=@([pscustomobject]@{Enabled=$true})} state {$foreign.State='Running'} directory {$foreign.Actions[0].WorkingDirectory='C:\\foreign'} }",
    " try { Assert-OwnedRefreshTask $foreign } catch { $rejected+= $kind }",
    '}',
    '[pscustomobject]@{admitted=$true;rejected=$rejected} | ConvertTo-Json -Compress',
  ].join('\n');
  const result = JSON.parse(execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], {encoding:'utf8', windowsHide:true}));
  assert.equal(result.admitted, true);
  assert.deepEqual(result.rejected, ['action', 'principal', 'trigger', 'state', 'directory']);
});
