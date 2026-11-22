---
name: codex-peer
description: Ask Codex through this PC's canonical shared AppServer for review, design discussion, debugging, or delegated implementation, preserving exact task identity and Desktop ownership.
---

# Codex peer

Adapted from `wywwzjj/adversarial-peers` (Apache-2.0). Use the shared-server adapter below. Do not run `codex exec`, `codex app-server`, an npm Codex runtime, or a private broker. The adapter uses the existing launcher state, validation, client, and Desktop delivery route.

Write the bounded task to a UTF-8 file in an ignored/private work directory. Include scope, meaningful context, allowed changes and the expected result. Delegate only authorized work. A delegated peer returns to its caller and does not delegate recursively. One writer owns a file at a time.

Write a JSON request with `peer: "codex"`, `action: "ask"`, a fresh UUID `operationId`, absolute `messageFile`, and the exact `threadId` of the intended authorized task. Add `workspace` to bind delivery to the expected directory. For a new peer, explicitly use `create: true`, an absolute `workspace`, and omit `threadId`; use `mode: "review"` for a new read-only peer or `mode: "implement"` for authorized changes.

New Codex peers optionally accept `model` (`gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6.1-terra`) and `effort` (`low`, `medium`, `high`, `xhigh`). Follow the user's current model policy: use Luna for clear, bounded independent work and an allowed Sol for ambiguous work, cross-file dependencies or design decisions. Start Sol at `medium`; reserve `xhigh` for particularly difficult reasoning. For example, add `"model": "gpt-6-luna", "effort": "low"` for a small, fully specified task. Omitted model keeps GPT-6.1 Sol; omitted effort keeps the runtime default. `max`, `ultra` and other unlisted values are rejected before dispatch and recorded in the operation journal. These settings apply only to new peers; existing tasks retain their model, effort, workspace, permissions and goal.

Run executable `@NODE@` with the arguments `@CONTROL_ROOT@/collaboration/peer.mjs` and `ABSOLUTE_REQUEST.json`. Quote paths as required by the host shell; on PowerShell invoke an executable path with `&`.

The adapter reads the current task, goal and turn, loads only an unloaded task through the existing Desktop owner route, then steers the exact active turn or starts once on the same idle task. It never reactivates a paused goal. Preserve explicit stops, HOLDs and completed work; do not select another task merely because the target is unavailable.

The result distinguishes `accepted`, `completed`, `failed` (a truly failed or aborted turn), `not-delivered` (input was not delivered) and `unknown` (do not resend), with exact `threadId` and `turnId` when accepted. Waiter trouble stays in `waiterWarning` while checking the rollout or exact supported turn read. The durable journal also records acceptance separately from completion. The call waits for that exact turn to finish. Preserve the host execution handle. A five-minute progress notice does not cancel the task. If ending the host while waiting, first arm its existing completion/notification route; never abandon an unresolved request silently.

For follow-ups, retain `threadId`, use a new operation ID and send a new bounded message. To inspect an uncertain operation use `action: "status"` with its original operation ID. To inspect a task or exact turn use `action: "read"`, `threadId`, and optionally `turnId`; `action: "list"` optionally accepts `search`. After `not-delivered`, the returned fallback can be used with a fresh operation ID and `deliveryRoute: "appserver"` on that same thread; this loads only an unloaded thread and preserves its settings. Do not blindly resend a request with a new UUID after UNKNOWN. A later stop or HOLD overrides continuation; do not restart or interrupt other tasks.

Assess findings against code and actual requirements. Do not accept peer claims as proof or introduce automatic mutual-review loops. This skill does not grant deployment, publication, external messaging, credentials, or broader filesystem authority.
