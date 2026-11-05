import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  waitForTurnCompletion,
  inspectLoadedActivity,
  deliverRuntimeCompletion,
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

test('loaded activity allows a finished child to unload but blocks newly loaded unverified work', async () => {
  for (const late of [null, 'LATE']) {
    let inventory = ['IDLE', 'CLOSED'];
    const client = new FakeClient((method, params) => {
      if (method === 'thread/loaded/list') return { data: inventory, nextCursor: null };
      if (method === 'thread/read' && params.threadId === 'IDLE') {
        return { thread: { id: 'IDLE', status: { type: 'idle' } } };
      }
      if (method === 'thread/read' && params.threadId === 'CLOSED') {
        inventory = late ? ['IDLE', late] : ['IDLE'];
        throw new Error('thread/read: {"code":-32600,"message":"thread not loaded: CLOSED"}');
      }
      throw new Error('Unexpected update preflight operation: ' + method);
    });
    assert.deepEqual(await inspectLoadedActivity(client), { idle: late === null });
  }
});

test('a loaded task in progress blocks Desktop closure', async () => {
  const client = new FakeClient(method => {
    if (method === 'thread/loaded/list') return { data: ['BUSY'], nextCursor: null };
    if (method === 'thread/read') return { thread: { id: 'BUSY', status: { type: 'active' } } };
    throw new Error('Unexpected update preflight operation: ' + method);
  });
  assert.deepEqual(await inspectLoadedActivity(client), { idle: false });
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
    '-TurnTimeoutSeconds 0 -RestartTimeoutSeconds 0 -DesktopCloseTimeoutSeconds 0',
    "-PackagePath 'C:\\update folder\\ChatGPT.msix' -PackageSha256 '" + 'a'.repeat(64) + "'",
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

test('completion delivery reads the current turn and sends exactly once without settings overrides', async () => {
  for (const active of [true, false]) {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/read') return { thread: { id: 'THREAD' } };
      if (method === 'thread/turns/list') return { data: [{ id: 'TURN', status: active ? 'inProgress' : 'completed' }] };
      assert.equal(method, active ? 'turn/steer' : 'turn/start');
      assert.deepEqual(Object.keys(params).sort(), active
        ? ['expectedTurnId', 'input', 'threadId'] : ['input', 'threadId']);
      if (active) assert.equal(params.expectedTurnId, 'TURN');
      return { turn: { id: active ? 'TURN' : 'NEW-TURN' } };
    });
    const receipt = await deliverRuntimeCompletion(client, 'THREAD', 'update settled');
    assert.equal(receipt.accepted, true);
    assert.equal(client.calls.length, 3);
    assert.equal(receipt.turnId, active ? 'TURN' : 'NEW-TURN');
  }
});

test('uncertain completion delivery is never replayed', async () => {
  let writes = 0;
  const client = new FakeClient((method) => {
    if (method === 'thread/read') return { thread: { id: 'THREAD' } };
    if (method === 'thread/turns/list') return { data: [] };
    writes++;
    return {};
  });
  await assert.rejects(deliverRuntimeCompletion(client, 'THREAD', 'done'), /uncertain/);
  assert.equal(writes, 1);
});

test('completion resumes an unloaded task with its saved settings before delivering', async () => {
  let loaded = false;
  const client = new FakeClient((method, params) => {
    if (method === 'thread/read') return { thread: { id: 'THREAD', status: { type: 'notLoaded' } } };
    if (method === 'thread/resume') {
      assert.deepEqual(params, { threadId: 'THREAD', excludeTurns: true });
      loaded = true;
      return { thread: { id: 'THREAD' } };
    }
    assert.ok(loaded, 'new runtime rejects turn operations on an unloaded task');
    if (method === 'thread/turns/list') return { data: [] };
    assert.equal(method, 'turn/start');
    assert.equal(params.threadId, 'THREAD');
    return { turn: { id: 'DELIVERED' } };
  });
  assert.equal((await deliverRuntimeCompletion(client, 'THREAD', 'done')).turnId, 'DELIVERED');
});

test('default turn wait has no agent deadline and observes terminal readback', async () => {
  const client = new FakeClient(() => ({ data: [{ id: 'TURN', status: 'completed' }] }));
  assert.equal((await waitForTurnCompletion(client, 'THREAD', 'TURN')).status, 'completed');
});

test('refresh requests normal application shutdown once and respects a veto', {
  skip: process.platform !== 'win32',
}, () => {
  const source = fs.readFileSync(refreshScriptPath, 'utf8');
  const close = extractPowerShellFunction(source, 'Request-DesktopClose', 'Wait-ForOldRuntimeExit');
  for (const returnCode of [0, 350]) {
    const script = [
      "$ErrorActionPreference='Stop'; $DesktopCloseTimeoutSeconds=0; $script:calls=0",
      'function Write-RefreshLog { param($Message) }',
      'function Get-DesktopRootProcesses { param($DesktopExecutable) if($script:calls -eq 0){[pscustomobject]@{ProcessId=43}} }',
      "function Get-Process { param($Id) [pscustomobject]@{Id=$Id;StartTime=[datetime]'2026-11-06T00:30:00Z'} }",
      `function Invoke-CodexDesktopNormalShutdown { param($ProcessId,$ExpectedExecutable,$ExpectedStartTimeUtc,[switch]$Execute) $script:calls++; [pscustomobject]@{ShutdownRequested=[bool]$Execute;ReturnCode=${returnCode};AffectedProcessIds=@($ProcessId)} }`,
      close,
      "$outcome='normal'; try{Request-DesktopClose -DesktopExecutable 'fixture'}catch{$outcome='veto'}",
      '[pscustomobject]@{calls=$script:calls;outcome=$outcome} | ConvertTo-Json -Compress',
    ].join('\n');
    const result = JSON.parse(execFileSync(windowsPowerShell(), ['-NoProfile','-NonInteractive','-EncodedCommand',encodedPowerShell(script)], {encoding:'utf8',windowsHide:true}));
    assert.equal(result.calls, 1);
    assert.equal(result.outcome, returnCode === 0 ? 'normal' : 'veto');
  }
});

test('encoded scheduled controller is one invocation with all arguments in Windows PowerShell', {
  skip: process.platform !== 'win32',
}, () => {
  const source = fs.readFileSync(refreshScriptPath, 'utf8');
  const builder = extractPowerShellFunction(source, 'New-RefreshControllerCommand', 'Start-DetachedRefreshController');
  const script = [
    "$ErrorActionPreference='Stop'",
    "$refreshScriptPath='C:\\update folder\\Refresh.ps1'",
    "$PackagePath=\"C:\\Owner's folder\\ChatGPT.msix\"",
    "$PackageSha256='" + 'a'.repeat(64) + "'",
    "$WaitForThreadId='00000000-0000-0000-0000-000000000001'",
    "$WaitForTurnId='00000000-0000-0000-0000-000000000002'",
    "$FromVersion='26.1007.2314.0'; $ToVersion='26.1029.7803.0'",
    "$TurnTimeoutSeconds=0; $RestartTimeoutSeconds=0; $DesktopCloseTimeoutSeconds=0",
    "$ScheduledTaskName='Codex Shared Runtime Refresh'",
    builder,
    "$command=New-RefreshControllerCommand -RequestId '00000000-0000-0000-0000-000000000003'",
    '$tokens=$null; $errors=$null',
    '$ast=[Management.Automation.Language.Parser]::ParseInput($command,[ref]$tokens,[ref]$errors)',
    '[pscustomobject]@{statements=$ast.EndBlock.Statements.Count;errors=$errors.Count;parameters=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandParameterAst]},$true) | ForEach-Object ParameterName)} | ConvertTo-Json -Compress',
  ].join('\n');
  const result = JSON.parse(execFileSync(windowsPowerShell(), ['-NoProfile','-NonInteractive','-EncodedCommand',encodedPowerShell(script)], {encoding:'utf8',windowsHide:true}));
  assert.equal(result.statements, 1);
  assert.equal(result.errors, 0);
  assert.deepEqual(result.parameters, ['WaitForThreadId','WaitForTurnId','FromVersion','ToVersion',
    'TurnTimeoutSeconds','RestartTimeoutSeconds','DesktopCloseTimeoutSeconds','PackagePath','PackageSha256',
    'ScheduledController','RefreshRequestId','ScheduledTaskName']);
});
