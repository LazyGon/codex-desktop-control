# Codex Desktop Control

Windows control plane for sharing one loopback-only Codex app-server between
Codex Desktop, local controller commands, and a private Discord remote UI.

## Components

- `launcher/`: builds and installs the **Codex Shared Server** launcher. It
  starts the bundled app-server on `ws://127.0.0.1:8798`, starts Desktop with
  `CODEX_APP_SERVER_WS_URL`, verifies the Desktop connection, and owns cleanup.
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

```powershell
.\control\codex-control.cmd status
.\control\codex-control.cmd list --limit 10
.\discord-bridge\Get-DiscordBridgeStatus.ps1
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md) and
[discord-bridge/docs-operations.md](discord-bridge/docs-operations.md) for the
phone and recovery workflows.

## Update and uninstall

After pulling an update, rerun `Install.ps1` with the same Discord IDs. Existing
DPAPI credentials are reused when no new token is supplied.

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
npm --prefix .\discord-bridge run check
npm --prefix .\discord-bridge test
powershell.exe -NoProfile -File .\control\Test-CodexControl.ps1
```

`CODEX_APP_SERVER_WS_URL` is an internal Desktop integration and may change in
a future Codex release. The launcher verifies the actual Desktop connection on
every start instead of assuming compatibility.
