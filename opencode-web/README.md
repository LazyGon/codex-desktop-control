# OpenCode Web + local Ollama

Windows installation for a browser-based coding workspace. No Codex App Server,
Desktop, Discord Bridge, Ollama service, or existing Tailscale route is restarted.

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

## Setup and operation

Install the pinned official npm package with `npm install --prefix D:\AI\OpenCode\runtime opencode-ai@1.19.3 --save-exact`.
Then run `OpenCode-Web.ps1 -Mode Initialize`, create the alias with `ollama create qwen3.5-opencode:4b -f Modelfile`,
and run `OpenCode-Web.ps1 -Mode Register`. Start the registered task once. Verify authenticated
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
health, model/provider, workspace and HTML delivery. `Test-OpenCode-Smoke.ps1` makes
one synthetic model request to write `setup-smoke/index.html` only, with a session-local
deny-all policy except that exact file's read/write. It records the exact session before
dispatch and refuses replay if a receipt or target exists. Reconcile interrupted requests
by that session; do not resend or delete the receipt. The test does not use private data.

This server has the Windows user's privileges, subject to OpenCode's approval controls.
Do not expose it publicly. HTTPS activation may require a Tailscale account administrator.
The Windows-native build is officially available; WSL remains upstream's recommendation
for maximum terminal compatibility. No WSL installation or Windows restart is part of setup.
