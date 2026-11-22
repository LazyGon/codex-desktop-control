# System-error recovery reference

適用範囲のAGENTSにある必須原則を前提に、対象作業に必要な節だけ参照する。履歴や例は新しい権限・製品契約を追加しない。control相対pathは C:/Users/lazyg/Documents/ChatGPT/codex desktop control 基準。

## System-error recovery (2026-10-13)

- Image-history Bad Request repair is a separate, confirmed-episode route in the
  same worker. Read `docs/image-history-repair.md` before diagnosing/registering it.
  Only an operator-confirmed image cause, pinned to the exact task and failed turn,
  permits image offload and compaction. Image presence or HTTP 400 alone is not
  evidence of that cause. Capacity failures retain the ordinary recovery path.
  Preserve backups, same-thread settings, stop/exclusions and UNKNOWN fences.
- OMEN deployment (2026-10-22) uses the Owner-supplied, hash-pinned package via
  `control/Install-OmenSystemErrorRecovery.ps1`; see
  `docs/omen-system-error-recovery.md`. Keep the original package immutable and
  use fresh OMEN-local state under `%LOCALAPPDATA%/CodexSystemErrorRecovery`.
  Never copy another PC's config, task IDs, permits or journals. The derived
  package removes unsupported count/time ceilings: null/omitted optional caps
  mean unlimited, explicit evidence-backed limits remain supported, and the
  scheduler has no execution deadline. RPC page sizes are batch shapes, not
  inventory limits. UNKNOWN and exclusive episode fences remain mandatory.
- `control/system-error-recovery.mjs` uses the verified canonical shared AppServer.
  The current-user Limited `Codex System Error Recovery` scheduled task invokes
  `control/system-error-recovery-launcher.py` through the existing windowless
  `pythonw.exe` at logon and once per minute. The Node worker is launched with
  `CREATE_NO_WINDOW`; PowerShell `-WindowStyle Hidden` alone did not prevent
  Windows Terminal from briefly appearing and taking focus on this PC. No
  separate server is created.
- The one-shot recovery CLI flushes its result and exits after its cycle and
  journal work finish. Residual runtime handles must not retain the scheduler's
  `IgnoreNew` slot. This is completion handling, not a deadline for pending RPCs.
- Only the latest confirmed typed terminal transient failure qualifies. Active,
  completed, interrupted, paused/budget-limited goals, excluded task IDs, native
  child tasks and unconfirmed direct-input owners are skipped. Workflow HOLD,
  INCOMPLETE, NOT_RUN and UNKNOWN delivery results are not system errors.
- Ordinary PC tasks are discovered in persistent ten-item pages and active loaded
  tasks are also read. Native children remain parent-owned and are explicitly
  reported as `native-child-owner-route`; this utility cannot resume them through
  the ordinary AppServer route. Missing metadata fails closed and is reported.
  No complete-inventory or live-failure recovery claim follows from registration
  or a successful cycle with zero eligible failures.
- Same-thread recovery preserves model, effort, workspace, role, approval and
  sandbox by supplying no settings overrides. Rate eligibility uses the actual
  top-level `ordinaryUsageAllowed` flag; account and credit values are not logged.
- The utility records an active goal identity and exact inProgress turn. The PO
  authorizes restoring that same goal only when the observed turn subsequently
  has a typed terminal system failure and becomes blocked, with no intervening
  goal/turn change. Initial blocked goals are ambiguous and remain untouched.
  This is temporal evidence: a simultaneous manual block cannot be distinguished
  by the current API, which has no causal-reason field. Paused/completed/changed
  objectives and budgets remain protected; usage counters are never reset.
- A goal restoration may automatically start a new turn before an explicit
  `turn/start`. Confirmed active-goal/inProgress snapshots from that race and
  accepted-start readback are saved immediately with the exact new turn. A
  typed inProgress start receipt may also preserve the active preflight tuple;
  an accepted ID alone never creates running-state evidence. This prevents a
  rapid capacity failure between minute polls from losing its causal history.
- A PO-directed work turn under an already blocked goal may instead have an
  explicit `po-directed-blocked-work` authorization pin. `authorizeBlockedWork`
  admits only that exact ordinary inProgress turn and goal/identity cut. Recovery
  then continues the work without setting the historical goal active. Only a
  confirmed automatic successor inherits the permit; its running receipt is
  saved in the episode journal before state, including the fast-failure gap.
  Completion, interruption, unrelated turns, changed goal status/updatedAt,
  objective, budget, task identity, missing or changed permit bytes revoke it.
  Initial blocked tasks without that exact permit remain untouched. This adds
  no Product scope or automatic sign-in; Windows sign-out/restart still ends
  Interactive workers until the user signs in again.
- An exclusive durable episode journal precedes resume/goal/start. A timeout or
  crash leaves the episode claimed and cannot trigger a blind resend. A genuinely
  new failed turn can be retried after backoff. Deferred inventory is persisted
  so scan/time budgets do not permanently starve older tasks.
- Episode identity is the fixed local domain plus exact task and failed-turn IDs;
  changed error messages/details never create a new restart key. Historical
  error-dependent journals remain immutable and fence the same thread/turn via
  a forward index. Their UNKNOWN/accepted/aborted claims are not cleared.
- Existing registration updates change only the action, preserving its triggers,
  principal, settings and enabled state. The manual PowerShell wrapper uses
  `ProcessStartInfo.CreateNoWindow` and waits for the real launcher exit code;
  it does not depend on PATHEXT or detached native-command exit tracking.
- Run `control/Register-SystemErrorRecovery.ps1 -Mode Status` for scheduler
  readback; `-Mode Stop` disables both config and task, and `-Mode Enable` restores
  them. The Node entrypoint also accepts `status`, `stop`, `enable`, `dry-run` and
  `run`. Config and sanitized cycle/episode state are under
  `state/global-system-error-recovery-20261013/`.
- Add intentional design waits to `config.json.excludedThreadIds` before leaving
  them unattended if their later system failures must not be resumed. Stop never
  kills an existing task/turn; the worker rereads config before each mutation.
- PID reuse or an unreadable lock fails closed. A repair lock left by a terminated
  repair process needs an ownership check and operator cleanup; never delete a
  journal to force a resend. No recovery mechanism adds Product scope, authority,
  account spend, billing, service restart, or external-operation permission.

### Parent notification successor (2026-10-13 direct PO)

- Native child terminal transient failures notify their genuine parent once per
  failed child turn. Parent identity comes from canonical `parentThreadId` and
  `source.subAgent.thread_spawn.parent_thread_id` (or the existing camel-case
  codec); conflicting/self/missing relationships never select a manager fallback.
  The notice asks the parent to reread the child and resume that same owner with
  supported collaboration. The utility never directly resumes a native child.
- Native metadata/turn reads are separated from its unsupported goal API. Old
  failed turns superseded by completed/inProgress/interrupted turns do not notify.
  The existing native own-turn timestamp selector excludes inherited pre-birth
  parent turns. An unknown birth cut fails closed rather than inventing a failure.
- An accepted task recovery or same-goal restoration also notifies a genuine
  parent when defined. Root ordinary tasks have no invented notification target.
- Parent paused/completed/blocked/budget-limited/excluded states never receive an
  automatic start. Active parents get exact-turn `turn/steer`; idle parents can
  get same-thread `turn/start` only with an existing active, unexhausted goal.
  Parent settings are inherited; no parent goal is restored merely to notify.
- `parent-notices/` is a separate durable episode journal. A pending protected
  parent can be reconsidered after a genuine state change; dispatching/accepted/
  UNKNOWN notices are never resent. Notice failure never repeats child recovery.
  Config stop/exclusions and cycle/start budgets apply to notification delivery.
- Pending notices use a persisted rotating cursor. One default notice slot is
  reserved for new failures; rediscovered queued/claimed episodes consume no new
  slot. At a one-notice limit, pending and new lanes alternate. Unused slots drain
  the remaining rotated queue after task scanning.
- Accepted recovery and goal-restoration evidence is durable before later reads
  and is the source for reconstructing missing pending recovery notices after a
  crash. Enqueue precedes notification budget checks; a newer/active child does
  not lose its already-confirmed recovery notification or repeat recovery.
- A genuine parent relationship alone does not make a task native. Explicit
  native source/subagent metadata or denied direct input selects the parent-owned
  route. Confirmed ordinary direct-input tasks with a genuine parent keep ordinary
  same-thread recovery and subsequently notify that parent.
