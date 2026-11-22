# 管理者窓口の参考手順

適用範囲のAGENTSにある必須原則を前提に、対象作業に必要な節だけ参照する。履歴や例は新しい権限・製品契約を追加しない。control相対pathは C:/Users/lazyg/Documents/ChatGPT/codex desktop control 基準。

正準クライアントは `C:/ProgramData/CodexAdminTerminal/Invoke-AdminTerminal.ps1`。`-ThreadId`、`-Workspace`、`-Purpose`、一意の`-OperationId`、監査済み`-ScriptPath`と必要な`-ScriptArguments`を渡す。長時間の`-Wait`は既存background workerと同thread completion callbackから使う。

## Canonical installation and execution

- Root: `C:/ProgramData/CodexAdminTerminal`. Config, host, guard, client, copied
  Node binary and results are Administrator-owned and not writable by the
  unelevated user. Only `inbox` grants this exact user SID Modify rights.
- `current.json` records host PID/start time, SID, elevated and phase. Verify the
  corresponding actual process and completed bootstrap/token-check receipts.
- `Invoke-AdminTerminal.ps1` requires explicit ThreadId, ScriptPath, Workspace,
  Purpose and GUID OperationId. Optional ScriptArguments is an array, not raw
  command text. `-Wait` waits for OS events and exits with the worker exit code.
- Guard reads `launcher/state/current.json`, then exact thread metadata/settings
  on the existing shared AppServer. Only active dangerFullAccess/never tasks are
  supported. It does not change task permissions, model, workspace or approval.
- Script must be a hashed local `.ps1` under the owning workspace or this control
  utility. The host retains a read lock on the source through execution. Audit
  dependencies too; a pinned wrapper is not an authorization for unrelated work.
- Requests and stdout/stderr remain local. Never put credentials, conversation
  contents or private data in arguments; do not expose the queue or elevate the
  Codex/Desktop/Bridge processes. Normal commands remain unelevated.

## Exactly-once boundary and recovery

`results/<GUID>.json` is recorded before admission. Phases are accepted,
dispatching, running, completed, rejected-not-executed or unknown*. The client
refuses every existing operation ID. Completed means a known process exit, not
that the requested real-world state was verified. Inspect actual installed
versions, effective drivers, services and functionality as appropriate.

Host restart marks unfinished receipts UNKNOWN and never replays them. A fresh
scheduled-task launch is permitted after verifying its fixed principal/action
and canonical state; never resubmit an uncertain command. Scheduler failure
recovery uses its documented minimum interval (one minute) and schema maximum
unsigned-byte count (255); recovery is of the host, not queued operation replay.
If that finite recovery is exhausted, diagnose before explicitly starting the
same fixed registered task once. No indefinite silent failed-operation retries.

Long installers run under a background worker with a durable same-thread
completion callback. A task ending while awaiting an external event must obey
the existing global asynchronous wait/resume rules. User-stopped tasks stay
stopped; guard metadata inspection is not a reason to start their turns.

## Stop and maintenance

Submit `Stop-AdminTerminal.ps1` through the host on explicit stop/revocation. It
disables the registered task and requests host exit after the current operation.
Do not kill an active installer. No automatic restart follows a clean requested
exit. Installation assets are protected; updates must be reviewed, hash-pinned
and installed through an already authorized operation, not edited unelevated.

`Repair-AdminTerminalGuard.ps1` performs a hash-pinned guard-only forward update
through this same host. It requires the exact executing operation and live host
identity, preserves the guard ACL, retains the old file, and exercises the
installed ASCII JSON envelope with Japanese/emoji through a Shift-JIS decoder.
The protected `guard-update.json` records the before/after hashes;
`Verify-AdminTerminal.ps1` checks this forward evidence against the immutable
bootstrap hash and verifies its protected ACL. Existing update evidence or an
unexpected installed hash stops the repair; failed/unknown jobs are not replayed.

Do not disable UAC, lower sandbox/approval, reuse SYSTEM tasks, alter unrelated
security/update policies, store a password, force-close apps or publish private
data. Ordinary Windows restart and firmware/destructive changes retain their
individual user-authorization conditions.

The 2026-11-22 instruction supersedes the one-shot ARSO policy: lazyg's Windows ARSO is permanently enabled (OptOut=0), with the screen locked after sign-in. Do not reuse the one-shot Execute/Restore route. Preserve prior operations. Windows restart still needs individual authorization; no password storage or security-policy weakening is authorized.

Official mechanism: [Task Scheduler security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks),
[failure recovery interval](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-restartinterval),
[recovery count schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-count-restarttype-element).

ARSOの現行方針はglobalの2026-11-22指定。旧一回限り再起動・復元記録は履歴として保持し再使用しない。
