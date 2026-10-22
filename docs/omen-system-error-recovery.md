# OMEN same-thread system-error recovery

The Owner-supplied `linked-files.zip` (SHA-256
`D806B45BDE8A1BB22CDA60335BDC609D59D977DAA36B9F459FC0B093643D1E6F`)
contains `OMEN-SystemErrorRecovery-20261022.zip` and its handoff. The target is
`LAPTOP-728OIQQK`, not Surface. Keep the received ZIP and original extracted
package immutable; do not transfer Surface config, conversation text, task IDs,
credentials, permits, or operation journals.

`control/Install-OmenSystemErrorRecovery.ps1 -PackageRoot <extracted-package>`
verifies the supplied content manifest, makes an independently recorded derived
package, then calls its installer against this canonical control utility.
`-CheckOnly` performs runtime checks without installing or registering a task;
`-PrepareOnly` installs and dry-runs without scheduling recovery. Existing task
registrations and install directories are never replaced. Use the package's
validation suite against the derived stage before live registration.
After `-PrepareOnly`, use the installed `Manage-OMEN.ps1 -Mode Register` once.
In this staged path `installation.json.phase` remains `prepared`; read the real
scheduler and `last-cycle.json` separately to verify registration/execution.

Owner AGENTS section 9 removes the unsubstantiated source defaults: two starts,
32 checked tasks, two parent notices, 45-second cycles, five-second RPCs,
the list RPC's separate 30-second cap, two-minute wrapper waits and five-minute
scheduler termination. Null/omitted optional count/time fields mean unlimited.
Positive explicitly selected, evidence-backed limits remain supported, without
the old arbitrary validation maxima. The old 100-pending-ID inventory admission
gate is also removed. Page sizes are RPC batch sizes, not an inventory ceiling.

The one-minute trigger is the supplied deployment contract. IgnoreNew and the
exclusive durable episode journal prevent overlapping or duplicate dispatches.
The existing exponential retry cadence starts at that one-minute interval;
the arbitrary ten-minute maximum was removed. Delays/next-eligible timestamps
must remain exactly representable JavaScript integers, otherwise recovery fails
closed before dispatch. API rate eligibility, goal budgets, deliberate stops,
protected/unknown goals, native-child ownership and UNKNOWN fences are unchanged.
No inference service, extra server, reboot, automatic sign-in or OS crash monitor
is installed. Recovery reads only thread/turn metadata (`includeTurns: false`,
`itemsView: notLoaded`), never Discord source or generated analysis text.

The local shared RPC client and runtime validator accept an explicit null timeout.
Their existing defaults for other callers are unchanged. Socket errors/close
still settle pending operations; an interrupted or uncertain write is journaled
and never replayed. No live server/Bridge restart is required for a new worker.

Installation is user-scoped under `%LOCALAPPDATA%\CodexSystemErrorRecovery`.
The scheduled task runs the existing `pythonw.exe`, which starts Node with
`CREATE_NO_WINDOW`, as the same SID with Limited/Interactive privileges, logon
and one-minute triggers, Hidden and IgnoreNew, with no execution deadline.
Do not fall back to a visible PowerShell launcher.

Use the installed `Manage-OMEN.ps1` with `Status`, `DryRun`, `Stop`, `Enable` or
`Uninstall`. Stop disables both config and scheduling, without killing task work;
uninstall retains all journals. Intentional design-wait exclusions must use
OMEN's exact thread IDs, not copied foreign IDs or title guesses.

Validation uses mock RPC/scheduler behavior and window-suppression checks, never
intentional live task failures or replayed historical deliveries. After deployment,
verify the exact scheduled action/SID/settings and a naturally scheduled cycle.
A successful dry run or zero eligible failures does not prove a real recovery;
only a future natural typed terminal transient error with its exact accepted
successor/immutable episode can establish that live case.

## Verified deployment: 2026-10-22, OMEN

The same-user Limited/Interactive task was registered with the exact windowless
action, Hidden/IgnoreNew, logon and PT1M triggers, and PT0S execution limit.
Its first natural scheduled cycle ran at 17:26:30 JST, finished successfully and
checked 13 task IDs, with zero recovery or parent-notice dispatches. Some IDs
were intentionally skipped because direct-input ownership was unconfirmed,
metadata could not be read, or the task was a native child. This is not proof
that every task is recoverable, nor a live-error recovery canary.

Validation passed: 60 focused Node tests; the Bridge's 314 tests and 106-file
syntax check; the derived package's 49 recovery tests, six Python launcher tests
and six mocked installer checks. No deliberately failed task, new server, Bridge
restart, reboot, paid API or private Discord content was used.

Deployment receipts and validation output are retained in the ignored local
`state/omen-recovery-deployment-5088fe34-d355-4bf7-803d-a74128ed4f4d/`.
The original extracted package and its manifest remain unchanged.

To stop recovery without stopping any work or deleting the no-resend journals:

```powershell
& "$env:LOCALAPPDATA\CodexSystemErrorRecovery\Manage-OMEN.ps1" -Mode Stop
```

Official event contract: <https://learn.chatgpt.com/docs/app-server#turn-events>.
