# Independent multi-PC Discord Bridge

Each PC connects to the same Discord Bot using its own local shared Codex
AppServer. There is no parent, leader election, lease, or exclusion channel.

## Routing

- Enable `multiPcEnabled` on **every PC**, including the existing installation.
  An old Bridge still ACKs foreign commands and is not safe to run in parallel.
- Assign each PC a stable, unique `instanceId` (at most 32 safe characters).
  Do not copy `data/state.json`, outbox files, or runtime files between PCs.
- Task commands, task panels, and modals check local task membership with a
  bounded, read-only `thread/read` before any reply/defer/autocomplete. A foreign
  or indeterminate target is silently ignored. The original task settings and
  approval boundaries are not changed by this check.
- New task creation still occurs only on the first ordinary message in an
  unbound text channel in a **locally registered project category**. A foreign
  task ID already present in its topic never creates a replacement task.
- Taskless commands are handled only in locally registered channels/categories.
  The categories are scoped by PC ID so two PCs with the same project name do
  not adopt, rename, or clean up each other's categories.
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
loopback for tests). It exposes only `POST /v1/tasks/list`, never AppServer
JSON-RPC or task mutations. Requests are HMAC-authenticated using a key derived
in memory from the same Bot token and application/guild IDs. The raw token is
never transmitted between PCs or stored in JSON. Peer source IP, instance ID,
authorized operator, timestamp and one-use nonce are checked. Responses contain
only task ID, title, directory, status and update time, not history or secrets.
Tailscale encrypts inter-PC transport; restrict TCP 18799 to these PCs in the
tailnet ACL/firewall. Do not forward this listener to the internet.

A missing Tailscale address does not stop ordinary local Discord execution.
The listener retries every 30 seconds and remote lists remain unavailable until
it can bind. Peers never resend, steer, or interrupt a task through this endpoint.

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
