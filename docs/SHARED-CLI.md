# Shared Codex CLI

The integrated installer places a user-scoped `codex` shim before the npm CLI
on `PATH`. After opening a new terminal process, an ordinary interactive Codex
invocation attaches to the same loopback app-server as Codex Desktop and the
Discord Bridge:

```powershell
codex
codex "continue this task"
```

Start **Codex Shared Server** first. The repository-local explicit entry point
remains available:

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
review`, `codex resume`, and `codex fork` cannot use the upstream remote TUI
transport, so the installed shim rejects them instead of silently creating an
isolated run. Administrative commands such as `codex login`, `codex update`,
and `codex doctor` pass through to the original npm CLI. Use `codex-original`
only when an isolated task run is explicitly intended.

`codex.exe app-server --listen stdio://` processes below a shared
`node_repl.exe` are internal Code Mode helpers, not independent CLI terminal
sessions. They can remain present while the CLI TUI, Desktop, and Discord Bridge
all use the shared WebSocket app-server for task state.

The app-server WebSocket transport and remote TUI are currently experimental.
Keep the listener on loopback; this launcher does not permit a remote host.
See the official [Codex App Server documentation](https://developers.openai.com/codex/app-server#connect-the-cli-terminal-ui)
for the upstream `--remote` contract.
