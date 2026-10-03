# Independent multi-PC Discord Bridge

Each PC connects to the same Discord Bot using its own local shared Codex
AppServer. There is no parent, leader election, lease, or exclusion channel.

## Routing

- Enable `multiPcEnabled` on **every PC**, including the existing installation.
  An old Bridge still ACKs foreign commands and is not safe to run in parallel.
- Assign each PC a stable, unique `instanceId` (at most 32 safe characters).
  Do not copy `data/state.json`, outbox files, or runtime files between PCs.
- To show a friendly PC name in Discord category names, set
  `instanceDisplayName` in that PC's ignored `config/config.json` (for example,
  `"FriendlyPC"`). `null` uses the stable `instanceId`. Keep display names unique
  across PCs; changing the display name does not change peer identity or routing.
  Project categories use `Codex - project [FriendlyPC]`, matching the fixed
  categories' `[FriendlyPC]` suffix. Long project names are shortened with `…`
  before the suffix. Stored category IDs are reused and their names are
  refreshed on Bridge startup.
- Task commands, task panels, and modals check local task membership with a
  bounded, read-only `thread/read` before any reply/defer/autocomplete. A foreign
  or indeterminate target is silently ignored. The original task settings and
  approval boundaries are not changed by this check.
- New task creation still occurs only on the first ordinary message in an
  unbound text channel in a **locally registered project category**. A foreign
  task ID already present in its topic never creates a replacement task.
- Taskless commands are handled only in locally registered channels/categories.
  Category names use the PC's unique display suffix, and stored category IDs
  remain locally owned, so two PCs with the same project name do not adopt,
  rename, or clean up each other's categories.
- After task synchronization, the Bridge removes empty pre-multi-PC project
  categories only when their names can be derived from projects currently known
  to this PC. It also removes empty pre-multi-PC archive categories. Categories
  owned by another PC, unknown legacy names, and any nonempty category are left
  unchanged.
- Opaque confirmation/input/file sessions are handled only by the PC which
  owns that in-memory session. Reopen expired UI after a Bridge restart.
- Task IDs are expected to be independent across PCs. A manually copied task
  with the same ID on two PCs makes an unqualified explicit ID ambiguous;
  merged list selections include the PC identity to avoid that ambiguity.

## Merged `/codex tasks`

The `全PCタスク一覧` control-panel button uses the same merged inventory. Only
the owner of the invoking channel ACKs the command. For this request only,
it fetches each configured peer's inventory in parallel and merges it with its
own inventory. Each PC can act as this request-scoped collector; starting order
does not matter. Results include the PC ID and list unavailable PCs explicitly.
The menu shows the newest 25 results and the attachment includes the complete
retrieved active, non-hidden, non-subagent inventory. Selecting a result routes
to its owner, even when the menu is in the other PC's control channel.

Copy `config/config.multi-pc.example.json` to the ignored local config and set
the real application/guild/user IDs, Tailscale IPv4 addresses, and reciprocal
peer entries. Each peer must list the other PC with the same stable instance ID.
For an existing installation, `Enable-MultiPcBridge.ps1 -InstanceId PC_A
-ListenHost 100.64.0.1 -PeerInstanceId PC_B -PeerHost 100.64.0.2` updates only the
routing/endpoint fields, takes a recoverable config backup, and does not start
the Bridge. Stop the Bridge gracefully first. Reverse the identities/addresses
on the other PC.
`taskListPeerTimeoutMs` defaults to 8000. Offline or timed-out inventories are
not treated as empty and are not replaced by stale snapshots.

The peer listener binds only to the configured Tailscale IPv4 address (or
loopback for tests). Its default route is `POST /v1/tasks/list`; enabling task
control adds only the fixed `POST /v1/tasks/operate` route. Neither route exposes
AppServer JSON-RPC, the WebSocket listener, or shell commands. Requests are HMAC-authenticated using a key derived
in memory from the same Bot token and application/guild IDs. The raw token is
never transmitted between PCs or stored in JSON. Peer source IP, instance ID,
authorized operator, timestamp and one-use nonce are checked. Responses contain
only task ID, title, directory, status and update time, not history or secrets.
Tailscale encrypts inter-PC transport; restrict TCP 18799 to these PCs in the
tailnet ACL/firewall. Do not forward this listener to the internet.

A missing Tailscale address does not stop ordinary local Discord execution.
The listener retries every 30 seconds and remote lists remain unavailable until
it can bind. An offline peer cannot receive operations; an unavailable PC is
reported explicitly rather than treated as an empty task list.

## Opt-in cross-PC task control

Both PCs must run this version of the Bridge. Each PC must set
`taskControlEnabled: true` and mark the other configured peer with
`allowTaskControl: true`. `Enable-MultiPcBridge.ps1 -EnableTaskControl` does that
while the Bridge is stopped gracefully. The sender must possess its own
DPAPI-protected Bot token under the current Windows user and choose an
allowlisted operator ID. The receiver also checks the Tailscale source IP,
peer identity, guild, operator allowlist, HMAC, timestamp, one-use nonce, and
target PC identity. Both devices holding the same Bot token are trusted peers;
the claimed operator ID is **not** independent proof of a Discord interaction.
Keep both Windows users and both devices under the same trust boundary.

From either PC, use `control/codex-peer.ps1` for an explicitly named other PC:

```powershell
.\control\codex-peer.ps1 --pc PC_B list
.\control\codex-peer.ps1 --pc PC_B projects
.\control\codex-peer.ps1 --pc PC_B read EXACT_TASK_ID
.\control\codex-peer.ps1 --pc PC_B create --project REGISTERED_PROJECT_ID --message "Investigate the tests"
.\control\codex-peer.ps1 --pc PC_B deliver EXACT_TASK_ID --message "Continue the work"
.\control\codex-peer.ps1 --pc PC_B interrupt EXACT_TASK_ID
.\control\codex-peer.ps1 --pc PC_B archive EXACT_TASK_ID
```

`send` and `steer` are available when the turn state is known; `deliver` chooses
the appropriate one. `read` returns at most 16 recent messages, 4,000
characters each. `create` uses only a visible project registered on the target
PC, shown by `projects`. Task operations require an exact task ID in that PC's
visible active inventory, and the owning AppServer confirms membership again
before acting. No model, sandbox, approval, or working-directory overrides are
sent. `archive` refuses an active turn; `interrupt` targets the current turn.

Effectful requests write an operation record on the receiving PC **before**
execution. Reusing the same `--operation-id UUID` returns its recorded result,
including after Bridge restart; changing its payload is rejected. If an effect
may have happened but the result was lost, the outcome is `unknown`. Do not send
the same instruction under a new operation ID until you inspect the target task.
No effect is automatically retried. The journal is flushed before an effect
starts and is ignored by Git under `discord-bridge/data/task-control-journal.jsonl`.
A damaged journal disables peer effects but leaves Discord and read-only lists
running; inspect the failure before repairing it. The journal is never pruned
automatically: after 10,000 distinct operation IDs, new effects fail closed.
Archive the journal for manual review before a deliberate rotation, and do not
reuse old operation IDs. Task control does not start or
stop the AppServer process itself or answer task approval prompts remotely.

## Shared AppServer and credentials

1. Install `launcher/Install-CodexSharedLauncher.ps1` on each PC. This registers
   `Codex Shared Server` and records a verified Node 22+ runtime, including the
   bundled Codex runtime when Node is not on the ordinary PATH.
2. After active Desktop work is idle, close the **normal Desktop application**
   yourself, then open `Codex Shared Server`. Do not kill an AppServer or copy
   another PC's launcher state. The launcher configures the local Desktop/tools
   shared transport and verifies that the Desktop uses its AppServer.
3. The Bridge discovers the loopback WebSocket from
   `launcher/state/current.json`; keep `appServerUrl: null` unless intentionally
   selecting another local endpoint. No external AppServer listener is needed.
4. Use `Enter-DiscordBotToken.ps1` for masked input. It verifies the configured
   Bot identity and saves `config/token.dpapi` with CurrentUser DPAPI and a
   restricted ACL. An Exporter user token cannot be used for the Bridge. Enter
   the Bot token separately on each PC; DPAPI ciphertext is not portable.
5. Use `Install-DiscordBridge.ps1 -NoStart` for initial setup. When dependencies
   have already been installed and checked, `-SkipDependencyInstall` avoids
   requiring an npm installation on the ordinary PATH. Re-install preserves
   existing routing/endpoint settings. Start only after both installations have
   the new routing code and their unique local configuration.

No live two-PC test is possible while one PC is off. Before enabling unattended
startup, verify one command in each PC's task channel, new task creation in each
managed project category, merged lists from both control channels, and a list
while the other PC is shut down. Confirm that only the task owner responds and
that unavailable peers are labelled without delaying local execution.

## Authorized autonomous first activation

When the user explicitly authorizes closing/updating/restarting Desktop,
`launcher/Initialize-CodexSharedDesktop.ps1` can perform the initial private-to-
shared transition using an independent, current-user, one-shot Windows task.
It requires the exact active source thread ID, turn ID, rollout file and source
turn timestamp (`-ThreadId`, `-TurnId`, `-SourceRollout`, `-Since`). Install the
Bridge logon task with `Install-DiscordBridge.ps1 -NoStart` first.

The controller waits for the exact source turn's `task_complete` event and five
idle checks for newly-started local work. Cancellation cancels the restart.
It does not pause goals. After a normal close request, only the admitted root
and orphaned private server can be stopped, with executable, creation-time and
parent checks. It allows a downloaded Store package to activate, starts the
shared launcher, independently verifies the loopback listener, executable hash,
actual Desktop TCP connection and read-only protocol/membership probe, then
starts/verifies the Bridge and sends one continuation to the same task.

Request-bound receipts and logs are under ignored `launcher/state` and
`launcher/logs`. A package update is recorded as applied only if the registered
version actually increased. An uncertain callback is not automatically retried.
This controller is not a recurring update monitor and does not update an
offline peer. Keep both PCs' Bridge code updated before parallel operation.
