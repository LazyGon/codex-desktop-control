# OpenCode Web + local Ollama

Windows installation for a browser-based coding workspace. No Codex App Server,
Desktop, Discord Bridge, existing Ollama owner, or existing Tailscale route is restarted.

- Runtime: `D:\AI\OpenCode\runtime` (`opencode-ai@1.19.3`, npm registry integrity in package-lock).
- Projects: `D:\AI\OpenCode\projects\mobile-apps`.
- Configuration, cache, session data and state: dedicated directories under the same D: root.
- Backend: `127.0.0.1:4096` only. Use Tailscale Serve for remote access; never Funnel.
- Login: `opencode`; random password stored with current-user DPAPI in `credentials/login.xml`.
  Run `OpenCode-Web.ps1 -Mode ShowLogin` on the PC to reveal it. No password in arguments or Git.
- Default model: `qwen3.5-opencode:4b`, an alias of the installed `qwen3.5:4b` with `num_ctx 65536`.
  This is the 64k context required by [Ollama's OpenCode guide](https://docs.ollama.com/integrations/opencode),
  not a downloaded larger model. The original model parameters and server are unchanged.
  The model's configured input/output sequence ceiling is this same 65536-token context,
  not an independently invented output/time limit. No generation-token or elapsed-time cap is added.
- Only the local Ollama provider is enabled. Sharing and automatic updates are disabled.
  Edits, shell commands, external-directory access and web access require approval.
  OpenCode permissions are application controls, not OS isolation; approve shell commands carefully.
- The current-user Limited `OpenCode Web (Ollama)` task launches silently at logon.
  It does not log Windows in, preload the model, or restart an exited server repeatedly.
- The separate Limited `Ollama (OpenCode)` task starts the installed `ollama serve` on
  loopback only when no verified existing Ollama endpoint is running. It uses the existing
  default-user model store; it does not restart another analysis task or its temporary server.
  It never kills an existing owner or preloads a model. If another owner already serves the
  port, that task is skipped and the dependency remains externally owned.

## Setup and operation

Install the pinned official npm package with `npm install --prefix D:\AI\OpenCode\runtime opencode-ai@1.19.3 --save-exact`.
Then run `OpenCode-Web.ps1 -Mode Initialize`, create the alias with `ollama create qwen3.5-opencode:4b -f Modelfile`,
and run `OpenCode-Web.ps1 -Mode Register` and `-Mode RegisterOllama`. Start the Ollama task,
verify `/api/version`, create the alias in its model store, and start the Web task. Verify authenticated
`/global/health`, `/provider`, `/config`, root UI, and a disposable workspace smoke test.
Use `OpenCode-Web.ps1 -Mode Status` for listener ownership and scheduled-task status.

For HTTPS, first enable Serve/certificates in the Tailscale admin page if requested by the CLI.
After checking the existing Serve configuration, add only the unused dedicated port:

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:4096
```

Keep existing 8765/8766 handlers unchanged. Do not replace the whole Serve configuration.
Access via `https://<this-PC-MagicDNS-name>:8443/` with Tailscale enabled on iPhone.
Check unauthenticated rejection and authenticated HTTPS separately. Local success alone
does not prove iPhone access or background mobile notifications.

`OpenCode-Web.ps1 -Mode Shortcuts -RemoteUrl <verified-HTTPS-URL>` creates desktop
`OpenCode Web` and `OpenCode Login` shortcuts without overwriting existing ones.
The login window initially masks the password; reveal it with `Show password`.
`Test-OpenCode-Web.ps1 -RemoteUrl <verified-HTTPS-URL>` checks HTTP authentication,
health, installed Ollama/alias, model/provider, workspace and HTML/script delivery. `Test-OpenCode-Smoke.ps1` makes
one synthetic model request to write `setup-smoke-<OperationId>/index.html` only, with a session-local
deny-all policy except that exact file's read/write. It records the exact session before
dispatch and refuses replay if a receipt or target exists. Reconcile interrupted requests
by that session; do not resend or delete the receipt. An explicit new GUID `-OperationId`
identifies each newly authorized test, not a retry of an uncertain operation. A durable exclusive
claim precedes session creation. The test does not use private data.

This server has the Windows user's privileges, subject to OpenCode's approval controls.
Do not expose it publicly. HTTPS activation may require a Tailscale account administrator.
The Windows-native build is officially available; WSL remains upstream's recommendation
for maximum terminal compatibility. No WSL installation or Windows restart is part of setup.

## Validated on 2026-10-20

- OpenCode 1.19.3, installed Ollama 0.34.1; HTTPS health/UI/script delivery and 401
  for an unauthenticated remote API request passed. Only local Ollama is connected.
- Initial synthetic test ended with a confirmed connection failure after the borrowed,
  externally owned Ollama process exited. Its original receipt is retained; no private
  analysis task was restarted and no inference request was replayed while uncertain.
- After starting the separately owned loopback Ollama task, a newly identified synthetic
  test returned normally and created the expected HTML through the agent's file tool.
  The original model weights were reused, without another model download.
- Observed loaded context 65536 and model VRAM about 5.0 GiB; total GPU use about 6.5 GiB
  on an 8 GiB card and roughly 16 GiB system RAM free during the brief verification.
  This is not a sustained thermal/stability guarantee or a full-project coding benchmark.
- Both Limited logon tasks and the visible masked login window were verified. A real
  reboot/logon cycle and the user's iPhone browser remain client-side acceptance checks.
