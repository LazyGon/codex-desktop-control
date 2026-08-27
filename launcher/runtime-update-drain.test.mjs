import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listAllThreads,
  pauseActiveGoals,
  resumePausedGoals,
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
  assert.equal(reads, 2);
});

test('shared launcher drains turns and replaces the server on package updates', () => {
  const source = fs.readFileSync(path.join(launcherRoot, 'Start-CodexShared.ps1'), 'utf8');
  assert.match(source, /Wait-RuntimeUpdateQuiescence/);
  assert.match(source, /Restore-RuntimeUpdateGoals/);
  assert.match(source, /restartAfterCleanup/);
  assert.doesNotMatch(source, /Updated Desktop attached automatically to the existing shared app-server/);
});

test('one-shot refresh waits the exact turn before replacing the owned runtime', () => {
  const source = fs.readFileSync(refreshScriptPath, 'utf8');
  assert.match(source, /WaitForTurnId/);
  assert.match(source, /Invoke-DrainCommand -Command 'wait-turn'/);
  assert.match(source, /Wait-AllThreadsIdle/);
  assert.match(source, /Wait-ForOldRuntimeExit/);
  assert.match(source, /Wait-ForNewRuntime/);
  assert.match(source, /Send-CompletionCallback/);
  assert.match(source, /controlScript deliver \$WaitForThreadId/);
  assert.match(source, /Start-DetachedRefreshController/);
  assert.match(source, /Register-ScheduledTask/);
  assert.match(source, /Start-ScheduledTask/);
  assert.match(source, /controllerLaunchMode = 'scheduled-task'/);
  assert.match(source, /requestId = \$RefreshRequestId/);
  assert.match(source, /DesktopCloseTimeoutSeconds = 120/);
  assert.match(source, /AddSeconds\(\$DesktopCloseTimeoutSeconds\)/);
  assert.doesNotMatch(source, /AddSeconds\(15\)/);

  const controllerBody = source.slice(source.indexOf('$controllerExitCode = 0'));
  assert.ok(
    controllerBody.indexOf('Wait-ForControllerAcceptance')
      < controllerBody.indexOf('$oldState = Get-VerifiedRuntimeState'),
    'the controller must receive the request-bound acknowledgement before runtime work',
  );
  assert.ok(
    controllerBody.indexOf("Invoke-DrainCommand -Command 'pause-active'")
      < controllerBody.indexOf("Invoke-DrainCommand -Command 'wait-turn'"),
    'active goals must pause before the exact turn wait',
  );
  assert.equal(
    (source.match(/\$delivery = Send-CompletionCallback -NewState \$newState/g) ?? []).length,
    1,
    'the controller must make one callback attempt',
  );
});

test('one-shot refresh fails closed around ownership, overlap, and live Desktop identity', () => {
  const source = fs.readFileSync(refreshScriptPath, 'utf8');
  assert.match(source, /Local\\CodexSharedRuntimeRefreshLaunch/);
  assert.match(source, /Local\\CodexSharedRuntimeRefreshController/);
  assert.match(source, /Assert-OwnedRefreshTask -Task \$existingTask/);
  assert.match(source, /Assert-NoUnresolvedRefreshReceipt/);
  assert.match(source, /\$receipt\.phase -notin @\('completed', 'failed'\)/);
  assert.match(source, /MultipleInstances IgnoreNew/);
  assert.match(source, /phase = 'controller-accepted'/);
  assert.match(source, /Wait-ForControllerAcceptance/);
  assert.match(source, /Refresh request \$RefreshRequestId has already started/);
  assert.match(source, /\$state\.desktopConnectionVerified -ne \$true/);
  assert.match(source, /Test-DesktopWebSocketConnection/);
  assert.match(source, /\$listener\[0\]\.LocalAddress -ne '127\.0\.0\.1'/);
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
  assert.match(writeFunction, /\[IO\.File\]::Replace/);
  assert.doesNotMatch(source, /Remove-Item -LiteralPath \$resultPath/);

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

test('Windows PowerShell 5.1 registers and manually runs a no-trigger task', {
  skip: process.platform !== 'win32',
}, () => {
  const taskName = `Codex Refresh Test ${randomUUID()}`;
  const repositoryRoot = path.dirname(launcherRoot);
  const source = fs.readFileSync(refreshScriptPath, 'utf8');
  const ownershipFunction = extractPowerShellFunction(
    source,
    'Assert-OwnedRefreshTask',
    'Assert-NoUnresolvedRefreshReceipt',
  );
  const ownedController = [
    `& '${refreshScriptPath.replaceAll("'", "''")}' \``,
    "    -WaitForThreadId '00000000-0000-0000-0000-000000000001' `",
    "    -WaitForTurnId '00000000-0000-0000-0000-000000000002' `",
    "    -FromVersion '26.820.1.0' `",
    "    -ToVersion '26.820.2.0' `",
    '    -TurnTimeoutSeconds 1800 `',
    '    -RestartTimeoutSeconds 240 `',
    '    -DesktopCloseTimeoutSeconds 120 `',
    '    -ScheduledController `',
    "    -RefreshRequestId '00000000-0000-0000-0000-000000000003' `",
    `    -ScheduledTaskName '${taskName.replaceAll("'", "''")}'`,
  ].join('\r\n');
  const ownedPayload = encodedPowerShell(ownedController);
  const safePayload = encodedPowerShell('Start-Sleep -Seconds 2; exit 23');
  const starter = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$name = ${quotePowerShell(taskName)}
$exe = ${quotePowerShell(windowsPowerShell())}
$repositoryRoot = ${quotePowerShell(repositoryRoot)}
$refreshScriptPath = ${quotePowerShell(refreshScriptPath)}
$scheduledTaskDescription = 'One-shot controller for a safe shared Codex runtime refresh.'
$ScheduledTaskName = $name
${ownershipFunction}
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$ownedAction = New-ScheduledTaskAction -Execute $exe -Argument ${quotePowerShell(`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${ownedPayload}`)} -WorkingDirectory ${quotePowerShell(repositoryRoot)}
Register-ScheduledTask -TaskName $name -Action $ownedAction -Principal $principal -Settings $settings -Description $scheduledTaskDescription -Force | Out-Null
$task = Get-ScheduledTask -TaskName $name
Assert-OwnedRefreshTask -Task $task
[xml]$xml = Export-ScheduledTask -TaskName $name
$triggerCount = @($xml.SelectNodes("/*[local-name()='Task']/*[local-name()='Triggers']/*")).Count
Unregister-ScheduledTask -TaskName $name -Confirm:$false
$action = New-ScheduledTaskAction -Execute $exe -Argument ${quotePowerShell(`-NoLogo -NoProfile -NonInteractive -EncodedCommand ${safePayload}`)} -WorkingDirectory ${quotePowerShell(repositoryRoot)}
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Description 'Safe no-trigger ScheduledTasks execution probe.' -Force | Out-Null
$foreignRejected = $false
try { Assert-OwnedRefreshTask -Task (Get-ScheduledTask -TaskName $name) } catch { $foreignRejected = $true }
if (-not $foreignRejected) { throw 'A foreign same-name task passed the ownership check.' }
Start-ScheduledTask -TaskName $name
[pscustomobject]@{ triggerCount = $triggerCount; workingDirectory = $action.WorkingDirectory; ownershipValidated = $true; foreignRejected = $foreignRejected } | ConvertTo-Json -Compress
`;
  const cleanup = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$name = ${quotePowerShell(taskName)}
try {
  $deadline = [DateTimeOffset]::Now.AddSeconds(15)
  do {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $name
    if ([string]$task.State -eq 'Ready' -and $info.LastRunTime.Year -gt 2000) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTimeOffset]::Now -lt $deadline)
  [pscustomobject]@{ state = [string]$task.State; lastTaskResult = $info.LastTaskResult } | ConvertTo-Json -Compress
}
finally {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
}
`;

  try {
    const definition = JSON.parse(execFileSync(windowsPowerShell(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(starter),
    ], { encoding: 'utf8' }));
    assert.equal(definition.triggerCount, 0);
    assert.equal(definition.workingDirectory, repositoryRoot);
    assert.equal(definition.ownershipValidated, true);
    assert.equal(definition.foreignRejected, true);

    const completion = JSON.parse(execFileSync(windowsPowerShell(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(cleanup),
    ], { encoding: 'utf8' }));
    assert.equal(completion.state, 'Ready');
    assert.equal(completion.lastTaskResult, 23);
  } finally {
    const forcedCleanup = `
$ProgressPreference = 'SilentlyContinue'
$name = ${quotePowerShell(taskName)}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
`;
    execFileSync(windowsPowerShell(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(forcedCleanup),
    ], { encoding: 'utf8' });
  }
});
