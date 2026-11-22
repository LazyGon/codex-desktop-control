# Claude and Codex collaboration

`collaboration/skills` adapts the peer workflow from
[adversarial-peers](https://github.com/wywwzjj/adversarial-peers), under Apache-2.0.
The local transport is changed: Codex uses this repository's canonical shared
AppServer; Claude uses its published CLI and the user's own login. No broker or
additional Codex AppServer is installed. The transport makes no semantic routing
judgments, so it does not call another classification service.

Run `node collaboration/install.mjs` to install `claude-peer` for Codex and
`codex-peer` for Claude. Only these two skill files are installed; their executable
implementation remains in this repository. Existing differing files are backed up.
The next host turn/session discovers the skills; no shared-server restart is needed.

## Requests

Pass a local JSON request file to `node collaboration/peer.mjs REQUEST.json`.
Keep prompt text in an absolute UTF-8 `messageFile`, not in the command line.

```json
{
  "peer": "codex",
  "action": "ask",
  "operationId": "NEW-UUID",
  "create": true,
  "model": "gpt-6-luna",
  "effort": "low",
  "workspace": "C:/path/to/project",
  "messageFile": "C:/private/task.txt",
  "mode": "review"
}
```

For an existing Codex peer replace `create` with `threadId`. Keep the exact returned
thread ID for follow-ups. New Codex peers accept optional `model` values
`gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6.1-terra`, and `effort` values
`low`, `medium`, `high`, `xhigh`. Omission preserves GPT-6.1 Sol and the runtime's
default effort. Unlisted values, including `max` and `ultra`, fail before dispatch
and are journaled. Existing threads never receive model or effort overrides.
For Claude use `peer: "claude"` and optionally a prior
`sessionId`. Omitted mode defaults to `review`. `mode: "review"` limits a new Codex peer to read-only and a Claude peer
to planning and read tools. Existing Codex permissions are never overridden;
read-only review is part of the delivered task scope. `implement` requests retain
the user's normal permissions and may be blocked by an unanswered approval.

`status` reads an operation's durable outcome without dispatch; `read` reads an
exact Codex thread/turn, and `list` discovers matching ordinary Codex tasks. The
default `ask` waits for the exact turn, with a progress notice at five minutes.
The notice deadline does not terminate the worker. Detached requests are not offered
without a durable completion route. No automatic peer review loop or goal reactivation is installed.

Operation journals and raw Claude envelopes are local under
`state/agent-collaboration/`. An existing UUID is never dispatched again. If a
creation/delivery outcome is UNKNOWN, inspect its journal and the exact task before
considering another operation. A completed model turn is not independent proof
that its requested implementation is correct.

## Phone

The official Claude mobile app uses
[Remote Control](https://code.claude.com/docs/en/remote-control), not Discord.
Run `collaboration/Start-ClaudeMobile.ps1 -Workspace PROJECT` from a terminal.
Complete the official workspace-trust and Remote Control confirmation if prompted.
The named session is `Surface-collaboration`; find it under Code in the phone app,
signed in with the same Pro account. The PC and process must stay running. Ctrl+C
stops this Remote Control process. This does not stop Codex, change its listener,
enable auto-login, or install a scheduled task. From a Desktop Code conversation,
`/remote-control` connects that same conversation instead.

Only an actual connected session and a phone round trip establish mobile operation.
Installed files, account login, and the server starting are separate checkpoints.
