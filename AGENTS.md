# Codex Desktop Control Operating Rules

## TypeSafe project skill

- When working on this project, read `.agents/skills/typesafe-ai/SKILL.md` and
  apply its guidance where semantic judgments or AI-powered features are relevant.
  Follow its live documentation before implementing a TypeSafe integration.
- Keep exact task ownership, permissions, routing, and execution in code; model
  confidence is not authorization. Installing the skill does not itself authorize
  paid inference or sending project files or conversation data to an external API.
- Configure `TYPESAFE_API_KEY` with `typesafe/Enter-TypeSafeApiKey.ps1`, following
  the official SDK environment-variable convention. The input screen explicitly
  saves it to the current Windows user's environment; that registry storage is
  plaintext. Never print the key or put it in source, logs, or command arguments.
- Already-running processes do not inherit later environment changes. Before a
  TypeSafe call from an existing terminal, import the user variable into that
  process without displaying it. Do not restart Codex or other tasks for this.

- Treat `launcher/state/current.json` as the primary endpoint source and the
  legacy experiment state only as a migration fallback.
- Verify the current Desktop connection before stopping any app-server.
- Prefer `list` and `catchup` before selecting a target task.
- Use an explicit thread id for `send`, `steer`, `deliver`, or `interrupt` when
  multiple tasks are present.
- Do not expose the loopback WebSocket endpoint outside the machine.
- Do not modify product repositories while maintaining this control utility.
- Preserve target-task approval, sandbox, and workspace settings.
- Keep Discord Bot credentials DPAPI-protected and out of logs, command lines,
  source, and JSON configuration.
- Discord control must remain guild- and user-allowlisted. Do not add a raw
  shell command or expose the app-server listener.
- Stop the Discord bridge through its graceful stop request before considering
  process termination.

## Shared local administrator terminal

Use the user-authorized `Codex Admin Terminal` for administrative commands,
following the current user's global `$CODEX_HOME/AGENTS.md` (normally
`%USERPROFILE%/.codex/AGENTS.md`) and
`admin-terminal/AGENTS.md`. Verify its live identity and protected installation
first. Do not create per-task RunAs prompts after initial registration or bypass
the owning task's sandbox/approval settings. Preserve the operation ID and read
its durable result before considering any retry. This adds no raw Discord shell.

For the separately authorized per-restart sign-in, use `restart-signin/` and the
global one-shot ARSO instructions. Normal automatic sign-in stays disabled;
only a new, individually authorized agent restart may temporarily opt this SID
in. The protected `Codex Restart Sign-In Restore` action restores the previous
setting after sign-in. Use a fresh matching restart/admin operation ID and a
verified same-thread postboot receiver. Never reuse the maintenance restart,
force-close apps, restart other stopped tasks, store/recover passwords or change
other accounts. One separately authorized ARSO test boot completed on 2026-10-11;
the original OptOut=1 and diagnostic-channel state were restored. LSA320 alone
does not prove automatic sign-in: no postboot LSA321 was observed, and the initial
locked state remains unproven. Any additional test requires fresh restart
authorization. See the operation's `sign-in-verification.json` and
`state/windows-maintenance-20261011/maintenance-status-latest.json`.

## Commit and push completed changes

- The Owner gives standing authorization to commit and push verified repository
  changes made for the requested task. Unless the Owner explicitly says otherwise,
  finish implementation, maintenance, test, documentation, and instruction changes
  through commit and push to the configured upstream; do not leave them uncommitted
  merely because commit/push was not repeated in the latest request.
- Run checks proportionate to the change, inspect the exact staged diff, and group
  related changes into coherent commits with descriptive messages. Stage only the
  task's changes and preserve unrelated work in progress.
- Synchronize upstream changes when needed, preserving local changes before
  pull/rebase and reconciling equivalent changes without duplicating or discarding
  work. Do not force-push or overwrite unrelated changes to satisfy this rule.
- Verify the published commit identity against the remote before reporting push
  complete. If a push result is uncertain, reconcile the remote state before
  considering another attempt.
- If checks, conflicts, credentials, security boundaries, or another concrete
  blocker prevent publication, preserve the work and report exactly what remains
  uncommitted or unpushed. Do not claim completion or bypass the blocker.
- Read-only tasks or tasks with no repository changes require no empty commit or
  unrelated push. This rule does not authorize changes outside the requested task.

## Task creation and ChatGPT delivery boundary

- When the user requests a separate local Codex task, create it directly on the
  existing shared App Server with `thread/start`. Do not use Desktop/high-level
  `create_thread`, including when a project or projectless target is available.
- Preserve the requested workspace and existing approval/sandbox defaults. Read
  the returned exact ID with `thread/read`, verify membership in the paginated
  ordinary `thread/list`, then verify its Discord binding. A creation receipt,
  list membership, turn acceptance, and Discord binding are separate facts.
- Do not recreate a task when list/binding verification fails. Retain the exact
  ID and report the missing fact. Do not resume an interrupted predecessor.
- For task delivery, read its current turn immediately before exactly one
  `turn/steer` with `expectedTurnId` or `turn/start`. Require the accepted exact
  turn identity; an uncertain mutation must not be retried on another surface.
- Official ChatGPT `send_message_to_thread` returning only `threadId` does not
  establish delivery, persisted message identity, completion, or a callback.
  Do not use it as the Reviewer Accessor transport for governed reviews or
  attachment/Receiver handoffs. Preserve uncertain attempts without replay.
- See `docs/official-conversation-api-investigation-20261005.md` for the tested
  ownership boundary, upstream evidence, and supported operating routes.

## ReasoningVM shared operations

For RVM work, read `state/rvm-fast-operations-20261007/AGENTS.md` and reuse its
shared utilities for new operations. Do not copy delivery, raw evidence, hash,
journal, or canonical-join implementations into each request's script.
Keep existing pinned history immutable and Product scope/acceptance with its
designated owner. This utility policy adds no Product mutation authority.

For every new RVM implementation-reported design gap, follow the 2026-10-08
cross-frontier procedure in `state/rvm-fast-operations-20261007/AGENTS.md`:
convert the gap into a reusable check, screen the entire remaining frozen
design frontier and shared interfaces, then investigate affected contracts.
Reuse unchanged evidence; distinguish normal later-phase absence and proof
limitations from missing design. Management owns forward scope/interface
decisions; the verification owner retains ordinary Product proof.

## Windows command overhead (2026-10-12)

- Prefer a persistent Node REPL for eligible local file and API operations, and
  batch independent reads. Each shell tool call can create a separate PowerShell
  process; high concurrency adds startup and resource costs.
- The installed 0.162.0-alpha.17.2 shell selector resolves PowerShell to the
  WindowsApps `pwsh.exe` alias even when a full PowerShell path is supplied.
  That alias failed with access denied in PTY mode on this PC. For a required
  PowerShell PTY, select `shell: "cmd"` and invoke the existing unpackaged
  PowerShell executable with `-NoProfile -File` and an audited script. The
  bundled runtime is under `.cache/codex-runtimes/codex-primary-runtime/` in
  the current user's profile; verify it exists before use.
- For Node CLI operations, invoke Node directly where available. A command
  shell wrapper is a fallback, not evidence that all command latency is fixed.
  Keep cwd and argv explicit and preserve the owning task's permissions.
- PTY output includes terminal control sequences. Keep canonical JSON/evidence
  in files or use non-terminal API/Node output; do not hash PTY display bytes.
- A Node REPL child environment may omit ComSpec and expose only `.CPL` in
  PATHEXT. Before launching a persistent Windows service, validate these two
  values and inherit the saved Windows values for that child if necessary.
  This is a child-process repair, not a registry or security-policy change.
- Recent control reads use `recent-thread-messages.mjs`; do not fetch an entire
  rollout just to tail a few messages. Session completion caching consumes
  append bytes; machine state snapshots use compact atomic JSON.
- Evidence and limitations: ../その他/codex-performance-20261012/report-current.json
  records the installed Unicode guard fix and user-authorized exact executable
  Defender exclusions. Effective exclusion checks and eight concurrent commands
  verified the observed scanning bottleneck improved without a shared restart.
  The exact inducing API and future-version paths remain explicit limitations.
- The runtime initializer now prefers a signature-verified bundled PowerShell
  for future child launches. This changes only the launcher process PATH and
  takes effect at the next normal or individually authorized shared startup;
  do not treat the running server as updated. See launcher-powershell-fix.json
  in the same evidence directory.

## System-error recovery (2026-10-13)

- `control/system-error-recovery.mjs` uses the verified canonical shared AppServer.
  The current-user Limited `Codex System Error Recovery` scheduled task invokes
  `control/system-error-recovery-launcher.py` through the existing windowless
  `pythonw.exe` at logon and once per minute. The Node worker is launched with
  `CREATE_NO_WINDOW`; PowerShell `-WindowStyle Hidden` alone did not prevent
  Windows Terminal from briefly appearing and taking focus on this PC. No
  separate server is created.
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
