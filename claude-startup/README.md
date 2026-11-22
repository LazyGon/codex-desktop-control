# Claude at sign-in

`Register-ClaudeStartup.ps1` registers `Claude Sign-In Conversation` and
`Claude Sign-In Haiku` for the current user's interactive, limited token.
Each starts 30 seconds after sign-in, including an ARSO sign-in with the screen
locked. Registration does not start either session.

The windowless Python entry runs the PowerShell launcher, which opens Claude
minimized in `~/Documents/ChatGPT/その他`. The conversation resumes session
`5467c555-7279-5b55-b8ce-e262b1e2e1f7`; Haiku starts a fresh named conversation.
Both use the explicitly requested `bypassPermissions` mode and remote control.
No prompt is submitted by the launcher.

An existing matching Claude process in the same Windows session is left running.
A named mutex prevents overlapping launcher calls. A launch that exits is retried
once after 30 seconds. A live process without a CCRClient heartbeat is recorded
as unconfirmed and is not restarted. Debug logs and launch outcomes are under
`state/claude-startup/`; debug logs use fixed names with one previous generation.

Check without launching:

```powershell
./claude-startup/Start-ClaudeSession.ps1 -Session Conversation -CheckOnly
./claude-startup/Start-ClaudeSession.ps1 -Session Haiku -CheckOnly
```

Disable future launches without stopping running sessions:

```powershell
Disable-ScheduledTask -TaskName 'Claude Sign-In Conversation'
Disable-ScheduledTask -TaskName 'Claude Sign-In Haiku'
```

ARSO is a separate Windows setting. To undo the 2026-11-22 change, use the shared
administrator terminal to set this user's `UserARSO/<SID>/OptOut` DWORD back to
1 and re-enable `Codex Restart Sign-In Restore` while its lease is idle.
The original task XML, registry facts and global instruction bytes are preserved
under `state/signin-claude-20261122/`. Do not restore the entire global instruction
backup over subsequent instruction edits.
