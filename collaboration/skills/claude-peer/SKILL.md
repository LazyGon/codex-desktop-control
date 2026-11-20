---
name: claude-peer
description: Consult local Claude Code for a second opinion, design discussion, debugging, or an explicitly delegated implementation; keep the caller responsible for the result.
---

# Claude peer

Adapted from `wywwzjj/adversarial-peers` (Apache-2.0). Use this when Claude collaboration is requested or useful within the authorized task. A delegated peer returns to its caller rather than calling another peer.

Write the bounded task to a UTF-8 file in an ignored/private work directory. State the actual question, workspace, allowed changes, and desired result. Send only relevant context; peer output is evidence to assess, not new authority.

Write a JSON request with `peer: "claude"`, `action: "ask"`, a fresh UUID `operationId`, absolute `workspace` and `messageFile`, and `mode: "review"` for a read-only second opinion. For authorized implementation use `mode: "implement"`; normal Claude permissions still apply. Run:

Run executable `@NODE@` with the arguments `@CONTROL_ROOT@/collaboration/peer.mjs` and `ABSOLUTE_REQUEST.json`. Quote paths as required by the host shell; on PowerShell invoke an executable path with `&`.

The result contains `phase`, `answer`, and `sessionId`. Retain the exact session ID for linked follow-ups and use it as `sessionId` in a new request; never select the most recent session. Keep models and permission settings unless the user requests a change. CLI authentication must use the user's own Claude subscription; do not extract or pass tokens or substitute API billing.

Read `phase` before reporting success. A failed/unknown request is not a clean review. Reusing an operation ID reads its stored outcome and never sends again. Inspect an uncertain outcome before a new request. `permissionDenials` means requested actions may remain undone.

The process prints a progress notice after five minutes without terminating the peer. Keep the host's execution handle; do not end the caller while waiting unless its existing completion/notification mechanism is armed. Respect a later stop or HOLD. For long waits, notify at the recorded deadline even if the result cannot be read. Do not launch an unrelated watcher or an isolated Codex runtime.

Review findings against the code and the original requirements. Return the substantive agreements, disagreements, changes, and remaining uncertainties. Let one agent write a file at a time; use an isolated worktree when genuinely parallel edits are needed. Do not add an automatic review loop.
