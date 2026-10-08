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
