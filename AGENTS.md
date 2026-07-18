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
