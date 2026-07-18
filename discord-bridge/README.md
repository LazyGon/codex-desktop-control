# Codex Discord Remote

This is a private Discord control surface for the shared Codex Desktop
app-server. It keeps the app-server on `127.0.0.1`; only the bot makes an
outbound connection to Discord.

## Capabilities

- Creates a private `Codex Control` category with `codex-remote`, alert, and
  completion channels.
- Creates one private category per project and continuously synchronizes every
  top-level Codex task into its project category.
- Moves archived Codex tasks into `Codex Archived` and returns unarchived tasks
  to their project category. Moving a task channel into `Codex Archived` archives
  the Codex task; moving it back to its own project category unarchives it. A move
  to any unrelated category is immediately rolled back to its recorded category.
- Persists a stable project ID for each Discord category, Codex task ID for each
  task channel, and a per-message ledger for every transcript post.
- Reconciles every user instruction into one orange user card and keeps exactly
  one final assistant card for every Codex turn.
- Sends new turns, steers active turns, or chooses the correct mode with
  `deliver`.
- Mirrors user instructions entered in Codex Desktop into the bound task
  channel. Discord-originated instructions use the same display without being
  duplicated when app-server echoes them back.
- While an active turn is subscribed live, keeps one latest assistant card and
  freezes each previous commentary message as an immutable card when the next
  message starts. Historical and reconnect reconciliation does not backfill
  commentary cards; it synchronizes user messages and final answers only.
- Shows current commentary, reasoning, plans, tool progress, and token usage
  only on the latest card. A past commentary card contains only its title,
  message, task ID, turn ID, and message ID; a final card uses task and turn ID.
- Uses the last public assistant message when an older completed turn has no
  explicit `final_answer`, instead of displaying a missing-text placeholder.
- Synchronizes the Codex task name into its Discord channel name and prefixes
  it with `🟢` while a turn is running or `⚫` while stopped.
- Routes command, file-change, additional-permission, user-input, and MCP
  elicitation requests to Discord buttons, selects, and modals.
- Confirms `interrupt` before using app-server `turn/interrupt`; it does not
  kill the task process.
- Reconnects indefinitely, re-subscribes bound tasks, reconciles persisted
  message IDs with visible Discord IDs, and reports missed completions.
- Mentions the configured user with `タスクが完了しました。` on the first line
  in `codex-completions`, posts a one-line final-answer summary on the second
  line, and uses the bare Discord message URL as the final line.
- Reconciles active and archived task lists every 30 seconds, after reconnect,
  and immediately after task lifecycle notifications.
- Treats ordinary messages from allowed users in bound task channels as Codex
  `deliver` input. After app-server accepts the input, the bridge replaces the
  original Discord message with the same orange user-card format used for
  Desktop input. One image, or one text file up to 200 KB, can be attached to
  an ordinary message. Slash commands remain available for explicit modes and
  attachments.
- Starts at Windows logon and can start the formal shared Desktop launcher when
  the app-server is absent.

## Discord commands

| Command | Purpose |
| --- | --- |
| `/codex status` | Discord, bridge, app-server, and subscription health |
| `/codex tasks` | Select a recent task and open its task channel |
| `/codex open` | Open a task channel by task ID/autocomplete |
| `/codex deliver` | Steer when active, start a turn when idle |
| `/codex send` / `steer` | Force the requested delivery mode |
| `/codex compose` | Mobile-friendly multiline prompt modal |
| `/codex interrupt` | Confirm and interrupt the active Codex turn |
| `/codex watch` | Select `quiet`, `normal`, or `verbose` updates |
| `/codex pending` | Show unanswered approvals or input requests |
| `/codex sync` | Immediately reconcile every active and archived task |
| `/codex refresh` | Fetch current task state directly from app-server |

Each user instruction remains one orange card with `Task`, `Turn`, and `Message`
identity fields. Live commentary uses the same identity fields with a distinct
color. Long user, past commentary, and final output remains one card; its full
text is attached to that card.

The state schema is the durable lookup table:

- project ID -> one or more Discord category IDs;
- Codex task ID -> Discord task channel ID;
- Codex turn ID -> user, live commentary, final, and completion-notice message IDs.

Before sending during recovery, the bridge checks both that ledger and visible
message identity markers. A restart after Discord accepted a post but before
local state was written therefore converges on the existing post instead of
creating a second copy.

No project registration is required. The bridge follows every page of both the
active and archived `thread/list` views. User-owned top-level tasks are synced;
ephemeral and subagent child tasks remain represented inside their parent task
instead of becoming separate Discord channels. Discord category overflow is
sharded automatically when a category reaches 50 channels.

## One-time installation

1. Create a Discord application and bot in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy its **Application ID** and bot token.
3. In Discord, enable Developer Mode and copy the dedicated server's
   **Server ID**.
4. From the repository root, generate and open the least-privilege bot invite:

   ```powershell
   .\discord-bridge\New-DiscordBotInvite.ps1 -ApplicationId APPLICATION_ID -GuildId SERVER_ID
   ```

5. After adding the bot to the dedicated server, run the integrated installer:

   ```powershell
   .\Install.ps1 -ApplicationId APPLICATION_ID -GuildId SERVER_ID -EnablePlainMessageInput
   ```

To use ordinary task-channel messages as Codex instructions, enable
**Message Content Intent** on the application's **Bot** page in Discord
Developer Portal, then install with `-EnablePlainMessageInput`. Without that
explicit opt-in, slash-command operation continues without the privileged
intent.

The root installer first builds and installs the shared Desktop launcher, then
validates the token and server, defaults the allowlist to the server owner,
registers guild-scoped commands, installs a current-user Scheduled Task, starts
Desktop and the Bridge, and verifies that both use the same app-server. The
standalone `Install-DiscordBridge.ps1` remains available for Bridge-only repair
after the shared launcher has already been installed.

The token is stored with Windows DPAPI for the current user and a restricted
file ACL. The plaintext token exists only in the bridge child process
environment.

## Operations

```powershell
.\Get-DiscordBridgeStatus.ps1
.\Start-DiscordBridge.ps1
.\Stop-DiscordBridge.ps1
```

`Stop-DiscordBridge.ps1` writes a stop request and waits for a clean shutdown.
It deliberately does not use `Stop-Process`.

Logs are append-only JSONL under `logs/`. Runtime state and task/channel
bindings are atomically persisted under `data/`. Neither location contains the
Discord bot token.

## Verification

```powershell
npm audit --audit-level=high
npm run check
npm test
node .\scripts\smoke-app-server.mjs
npm run verify:discord
npm run verify:transcripts
```

Both Discord verification commands require `DISCORD_BOT_TOKEN` in the process
environment. `verify:transcripts` also checks category/task/turn linkage,
message-ledger references, duplicate identities, and the live-card invariant.
The installed service decrypts the DPAPI-protected token only for the child
process.

The bridge uses Discord's Gateway through `discord.js` and guild-scoped
application commands. Discord requires interaction acknowledgement followed by
edits/followups for longer work, so every app-server operation that may take
time is deferred before execution.

## Security boundaries

- Only the configured guild and explicit user IDs can invoke commands or
  components. Slash commands default to Discord administrators.
- Bot permissions are limited to Manage Channels, Manage Roles, View Channels,
  Send Messages, Embed Links, Attach Files, and Read Message History. Manage
  Roles is used only for private category permission overwrites.
- Discord input becomes Codex turn text. There is no raw shell endpoint.
- Ordinary-message input is accepted only in bound task channels, from the
  configured guild and user allowlist. It requires Discord's privileged Message
  Content Intent. Bot and webhook messages are ignored.
- Mentions are disabled in general bot output. Completion notifications allow
  only the configured `completionMentionUserId`.
- app-server remains loopback-only and is never tunneled to Discord or a LAN.
- The app-server protocol and `CODEX_APP_SERVER_WS_URL` integration are
  experimental. The formal launcher and bridge verify connectivity on every
  run.
