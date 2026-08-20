# Shared Codex CLI

The interactive Codex CLI can attach to the same loopback app-server as Codex
Desktop and the Discord Bridge. Start **Codex Shared Server** first, then run:

```powershell
.\control\codex-shared.cmd
```

Arguments for the interactive TUI are forwarded after the enforced remote
endpoint. For example:

```powershell
.\control\codex-shared.cmd --no-alt-screen -C C:\git\other\example
```

Use this read-only preflight in scripts or non-TTY environments:

```powershell
.\control\codex-shared.cmd --check
```

The launcher reads `launcher/state/current.json`, requires the
`ws://127.0.0.1:PORT` endpoint, verifies the Desktop connection, process,
executable SHA-256, and `/readyz`, and then starts the exact same `codex.exe`
version with `--remote`. Remote endpoint overrides are rejected.

This command is only for the interactive TUI. Existing `codex exec`, `codex
review`, and other non-interactive or administrative subcommands remain normal
standalone CLI commands.

`codex.exe app-server --listen stdio://` processes below a shared
`node_repl.exe` are internal Code Mode helpers, not independent CLI terminal
sessions. They can remain present while the CLI TUI, Desktop, and Discord Bridge
all use the shared WebSocket app-server for task state.

The app-server WebSocket transport and remote TUI are currently experimental.
Keep the listener on loopback; this launcher does not permit a remote host.
See the official [Codex App Server documentation](https://developers.openai.com/codex/app-server#connect-the-cli-terminal-ui)
for the upstream `--remote` contract.
