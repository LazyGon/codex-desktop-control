# Codex Desktop Control Operating Rules

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
