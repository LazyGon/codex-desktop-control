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
  recovery, and phone operation.
- `Install.ps1`: installs both the shared Desktop launcher and Discord Bridge,
  then verifies that both Desktop UI and Discord are connected to the same
  app-server.
- `Uninstall.ps1`: removes installed shortcuts and the Discord Scheduled Task
  without terminating a running Desktop session.

The app-server remains bound to loopback. Do not expose its WebSocket endpoint
to a LAN or the internet.

## Prerequisites

- Windows 10 or 11 with Codex Desktop installed for the current user.
- Windows PowerShell 5.1 and the .NET Framework C# compiler.
- Node.js 22 or newer with `npm` available on `PATH`.
- 7-Zip for file transfers larger than one Discord attachment.
- A private Discord server and a Discord application with a bot.

Enable **Message Content Intent** on the Discord application's **Bot** page if
ordinary task-channel messages should become Codex instructions.

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
3. creates the `Codex Discord Remote` current-user Scheduled Task;
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

If this checkout's healthy app-server is already listening, the launcher
validates its state, listener PID, executable, supervisor, package version, and
`/readyz` response. It then skips app-server startup and opens only Codex
Desktop on that existing connection. A server owned by another checkout or an
inconsistent state file is never adopted.

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

`codex-remote` and every task channel contain a pinned control panel. Task
panels provide delivery-mode and watch-level selects plus status refresh,
pending requests, a task control center, archive/restore, and confirmed
interrupt actions. After every turn ends, the task panel is reposted and pinned
below the final card so its controls remain at the latest channel position.
Pinned control panels use a dedicated purple embed color, while completed
Codex result cards remain blue, so the two surfaces are visually distinct.
They also provide a project-file browser, while assistant
cards expose safe local file links for download to the private task channel.
The linked-file picker can download every permitted link as one ZIP (or
numbered ZIP volumes), while preserving the same secret, link, and project
boundary checks used for individual downloads.
Large files are packaged as numbered 7z volumes with a SHA-256 manifest.
The task panel's `📦 Download project` action creates a confirmed full working
directory archive, including `.git` and protected regular files, as split 7z
volumes with a manifest. Filesystem links and special entries are excluded.
The task control center exposes model, reasoning effort,
permission profile, Plan/Default mode, Fast/service tier, personality, memory,
goal, compact, fork, review, and app-server background-terminal controls. The
global panel provides bridge status, account usage, read-only MCP/Skills/
Plugins/Hooks/experimental-feature inventory, full synchronization, pending
requests, and task navigation. Renaming
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
the cached Codex executable, and experiment artifacts. Do not force-add those
paths, even in a private repository.

## Verification

```powershell
node --test .\launcher\sync-desktop-projects.test.mjs
node --check .\launcher\read-thread-status.mjs
npm --prefix .\discord-bridge run check
npm --prefix .\discord-bridge test
powershell.exe -NoProfile -File .\control\Test-CodexControl.ps1
```

`CODEX_APP_SERVER_WS_URL` is an internal Desktop integration and may change in
a future Codex release. The launcher verifies the actual Desktop connection on
every start instead of assuming compatibility.
