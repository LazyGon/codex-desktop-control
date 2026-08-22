# Codex Desktop Control

Windows control plane for sharing one loopback-only Codex app-server between
Codex Desktop, local controller commands, and a private Discord remote UI.

## Components

- `launcher/`: builds and installs the **Codex Shared Server** launcher. It
  starts the bundled app-server on `ws://127.0.0.1:8798`, starts Desktop with
  `CODEX_APP_SERVER_WS_URL`, reconciles app-server task working directories
  with Desktop's local-project sidebar state before Desktop starts, verifies
  the Desktop connection, and owns cleanup.
- `control/`: lists, reads, resumes, starts, steers, interrupts, and watches
  tasks on the shared app-server.
- `discord-bridge/`: persistent private Discord UI for task display, control,
  approvals, Desktop message mirroring, archive synchronization, reconnect
  recovery, phone operation, and explicitly linked ordinary ChatGPT
  conversations through the sibling `reviewer-accessor` checkout.
  Transient failures across Discord gateway/REST, the Codex app-server,
  attachment fetches, DNS, TCP, and TLS recover without terminating the
  Bridge; authentication, certificate, configuration, and programming errors
  remain fatal.
- `Install.ps1`: installs both the shared Desktop launcher and Discord Bridge,
  then verifies that both Desktop UI and Discord are connected to the same
  app-server.
- `Uninstall.ps1`: removes installed shortcuts and the Discord Scheduled Task
  without terminating a running Desktop session.

The app-server remains bound to loopback. Do not expose its WebSocket endpoint
to a LAN or the internet.

## Prerequisites

- Windows 10 or 11 with Codex Desktop installed for the current user.
- PowerShell 7 or newer is preferred; Windows PowerShell 5.1 remains the
  supported fallback. The .NET Framework C# compiler is also required.
- Node.js 22 or newer with `npm` available on `PATH`.
- 7-Zip for file transfers larger than one Discord attachment.
- A private Discord server and a Discord application with a bot.

Enable **Message Content Intent** on the Discord application's **Bot** page.
It is required for the `Others` / `transfer-text` inbox and for optional
ordinary task-channel instructions, including linked ChatGPT channels.

## Install

Clone the repository to any local directory. Paths are derived from the clone
location; no fixed checkout path is required.

First authorize the bot in the private server:

```powershell
.\discord-bridge\New-DiscordBotInvite.ps1 `
  -ApplicationId DISCORD_APPLICATION_ID `
  -GuildId DISCORD_SERVER_ID
```

Then run the integrated installer:

```powershell
.\Install.ps1 `
  -ApplicationId DISCORD_APPLICATION_ID `
  -GuildId DISCORD_SERVER_ID `
  -EnablePlainMessageInput
```

The bot token is requested as a secure prompt and stored with Windows DPAPI for
the current user. The installer:

1. builds the shared Desktop launcher and creates Start menu and desktop
   shortcuts;
2. installs Discord dependencies, validates the bot and server, and registers
   commands;
3. builds the identifiable `CodexDiscordRemoteHost.exe` notification-area host
   and creates the `Codex Discord Remote` current-user Scheduled Task;
4. starts Desktop through the shared launcher and verifies its WebSocket
   connection; and
5. starts the Bridge and verifies Discord plus app-server connectivity.

If Codex Desktop is already open through its normal shortcut, quit it normally
and rerun the installer. The installer never kills that process.

Use `-NoStart` to install without launching Desktop or the Bridge. Use
`-SkipScheduledTask` for a session-only Bridge process instead of logon startup.

## Normal operation

Start Desktop from **Codex Shared Server**, not the standard Codex shortcut.
Two ascending tones mean the Desktop connection to the shared app-server was
verified. The Bridge starts at logon and can also start the shared launcher when
the app-server is absent.

The shared launcher resolves PowerShell in the same order as Codex on Windows.
It honors `pwsh.exe` on `PATH` as an explicit operator selection, then tries the
standard PowerShell 7 installation, `powershell.exe` on `PATH`, and finally
Windows PowerShell 5.1. It never supplies an execution-policy override and does
not propagate a parent process-level override.

If this checkout's healthy app-server is already listening, the launcher
validates its state, listener PID, executable, supervisor, package version, and
`/readyz` response. It then skips app-server startup and opens only Codex
Desktop on that existing connection. A server owned by another checkout or an
inconsistent state file is never adopted.

The launcher caches the package's `codex.exe` and
`codex-code-mode-host.exe` together in a version-specific directory. Current
app-server builds start the companion Code Mode host beside `codex.exe`; both
hashes must match the installed Desktop package before the runtime is reused.

If the Store replaces the `OpenAI.Codex` package while a shared session is
running, the launcher detects the new package version after the old Desktop
root exits, activates the updated Desktop, and verifies that it reattached to
the existing loopback app-server. At Windows logon, the Discord Remote host
starts the configured shared launcher before loading Discord dependencies, so
the shared Desktop wins the startup race after a reboot. The logon path honors
the existing `autoStartSharedDesktop` setting, and update recovery remains
scoped to the same package identity.

Before each Desktop start, the launcher reads the Bridge's managed project
paths and the app-server's active and archived task lists. While Desktop is
still stopped, it creates any missing local-project records and assigns tasks
to the project whose path exactly matches the task working directory. The
global Desktop state is backed up under `launcher/state/project-sync-backups/`
before an atomic update. This keeps tasks created from Discord visible in the
project sidebar after a restart without changing their Codex history or runtime
settings.

For a one-shot repair that waits for the current task to finish, gracefully
stops the Bridge, closes Desktop, reopens only Desktop on the existing
app-server, and verifies both the repaired assignment and Bridge reconnection:

```powershell
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList `
  '-NoProfile -ExecutionPolicy Bypass -File ".\launcher\Restart-CodexSharedWithProjectRepair.ps1" -WaitForThreadId ACTIVE_THREAD_ID -VerifyThreadId REPAIR_THREAD_ID'
```

The result is written to
`launcher/state/project-repair-last.json`.

```powershell
.\control\codex-control.cmd status
.\control\codex-control.cmd list --limit 10
.\discord-bridge\Get-DiscordBridgeStatus.ps1
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md) and
[discord-bridge/docs-operations.md](discord-bridge/docs-operations.md) for the
phone and recovery workflows.

To start a task from Discord, create a text channel inside an existing managed
project category and post the first instruction there. The Bridge creates a
Codex task with that project's working directory, names it from the channel,
binds the same channel, and delivers the post. It does not create tasks from
unbound channels in control, archive, or unrelated categories.

Discord access and completion notifications are configured independently in
`discord-bridge/config/config.json`. Only IDs in `authorizedUserIds` may submit
prompts, commands, or UI interactions. `completionMentionUserIds` is an
independent list of fixed notification subscribers and may be empty. For every
Discord-submitted prompt, the Bridge also records the actual executor on the
Codex turn. Its completion notice mentions that turn's executor or executors
plus the fixed subscribers, with duplicates removed.

Ordinary task-channel messages may include up to ten Discord attachments.
Images are sent through app-server as local image inputs. Documents,
spreadsheets, presentations, PDFs, archives, audio, video, and other regular
files are saved without execution under the task-scoped
`discord-bridge/data/incoming-files/` runtime inbox, then supplied to Codex as
absolute local file links. The default per-message and per-file input limit is
512 MB, subject to Discord's smaller upload limit. Attachments also work when
`deliver` steers an already-running turn.

The Bridge also creates a private `Others` category with a `transfer-text`
channel. A message there from an authorized user or Discord webhook is stored
verbatim as UTF-8 under `discord-bridge/data/transfer-text/<timestamp>.txt`.
Only the latest timestamped text file is retained; the next accepted message
replaces it. After the local write succeeds, the source Discord message is
deleted. A failed write leaves the message in Discord. This channel is a local
text inbox and never sends content to Codex.

`codex-remote` and every task channel contain a pinned control panel. Task
panels provide delivery-mode, watch-level, and per-task completion-report
selects plus status refresh, pending requests, a task control center,
archive/restore, and confirmed interrupt actions. Completion reporting defaults
to ON; turning it OFF keeps final cards in the task channel but suppresses
future `codex-completions` posts for that task. After every turn ends, the task
panel is reposted and pinned below the final card so its controls remain at the
latest channel position.
Automatic task-sync summaries are posted separately in `codex-sync`, keeping
the `codex-remote` control panel from being displaced by routine activity.
Codex subagents are shown as read-only Discord threads beneath their top-level
task channel. Each thread mirrors that agent's commentary, App Server reasoning
summaries, tool progress, and final answer. Nested agents are flattened beneath
the same task channel with their full agent path and depth retained. Active
subagent threads use `🟢`; finished threads use `⚫` and are archived without
creating separate completion-channel notifications.
Pinned control panels use a dedicated purple embed color, while completed
Codex result cards remain blue, so the two surfaces are visually distinct.
They also provide a project-file browser, while assistant
cards expose explicitly linked local files for download to the private task
channel. Linked regular files may be outside managed projects, including under
`.codex`, and secret-like names are not blocked. Windows-protected system
directories and filesystem links remain unavailable. The linked-file picker
can download every eligible link as one ZIP (or numbered ZIP volumes).
Large files are packaged as numbered 7z volumes with a SHA-256 manifest.
The task panel's `📦 Download project` action creates a confirmed full working
directory archive, including `.git` and protected regular files, as split 7z
volumes with a manifest. Project and `.git` archives have no aggregate transfer
limit; each volume stays within the configured Discord attachment size and is
posted separately. Filesystem links and special entries are excluded.
The task control center exposes model, reasoning effort,
permission profile, Plan/Default mode, Fast/service tier, personality, memory,
goal, compact, fork, review, and app-server background-terminal controls. The
global panel provides bridge status, account usage, read-only MCP/Skills/
Plugins/Hooks/experimental-feature inventory, full synchronization, pending
requests, task navigation, and a confirmed `履歴復元` action. That action is an
explicit exception to normal historical reconciliation: choose 1, 3, or 7
days to restore completed-turn user messages, commentary, final answers, and
App Server reasoning summaries across every Discord-managed non-archived task.
Raw private reasoning content is never posted. Renaming
a task channel renames the Codex task; the Bridge then restores the channel's
running/stopped status prefix.

## Update and uninstall

After pulling an update, rerun `Install.ps1` with the same Discord IDs. Existing
DPAPI credentials are reused when no new token is supplied.

Bots installed before pinned panels were added need one OAuth
re-authorization using the URL printed by the installer. Discord grants
**Pin Messages** separately from **Manage Messages**.

```powershell
.\Uninstall.ps1
```

Add `-RemoveConfiguration` to remove the protected bot token and local Discord
configuration. A running Desktop/shared app-server session is left intact until
Desktop exits normally.

## Repository boundary

The root `.gitignore` excludes bot credentials, generated configuration,
message ledgers, runtime state, logs, dependencies, generated launcher binaries,
the cached Codex runtime executables, and experiment artifacts. Do not force-add those
paths, even in a private repository.

## Verification

```powershell
node --test .\launcher\sync-desktop-projects.test.mjs
node --test .\launcher\runtime-cache.test.mjs
node --test .\launcher\shared-launcher.test.mjs
node --check .\launcher\read-thread-status.mjs
npm --prefix .\discord-bridge run check
npm --prefix .\discord-bridge test
powershell.exe -NoProfile -File .\control\Test-CodexControl.ps1
```

`CODEX_APP_SERVER_WS_URL` is an internal Desktop integration and may change in
a future Codex release. The launcher verifies the actual Desktop connection on
every start instead of assuming compatibility.
