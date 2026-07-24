# Codex Discord Remote

This is a private Discord control surface for the shared Codex Desktop
app-server. It keeps the app-server on `127.0.0.1`; only the bot makes an
outbound connection to Discord.

## Capabilities

- Creates a private `Codex Control` category with `codex-remote`, alert, and
  completion channels.
- Creates one private category per project and continuously synchronizes every
  top-level Codex task into its project category.
- Treats the first ordinary message in an unbound text channel inside a managed
  project category as a new task request. It starts the task in that project's
  working directory, derives its title from the channel name, binds the same
  channel, and serializes rapid follow-up messages to prevent duplicate tasks.
- Pins one persistent control panel in `codex-remote` and one in every task
  channel. The global panel exposes status, account usage, read-only Codex
  resource inventory, full sync, pending requests, and task navigation. Task
  panels expose delivery mode, watch level, detailed status, task-scoped
  pending requests, a task control center, archive/restore, and confirmed
  interrupt, plus a paged project-file browser. Control panels use a dedicated
  purple embed color; completed result cards remain blue.
- Reposts and pins the task control panel immediately below each terminal turn
  card. The previous bot-owned task panel is removed only after the replacement
  ID is persisted, so mobile users always find controls at the latest position.
- Provides a dropdown-first task control center backed by live app-server
  catalogs for model, reasoning effort, named permission profile, and
  Plan/Default mode. Additional screens expose Fast/service tier, personality,
  memory, goal, context compact, fork, review, and app-server-managed background
  terminals.
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
- Adds a `Linked files` button to assistant cards that contain Markdown links
  to absolute local Windows files. The resulting dropdown resolves only files
  inside managed Codex project trees (including explicitly linked sibling
  repositories under a parent shared by managed projects) and posts the
  selected file to its private task channel. The same picker offers
  `Download all as ZIP`, which packages every permitted link while excluding
  locked or unsafe entries.
- Browses one directory level at a time from a task's project root through the
  `Project files` panel button or `/codex-files`. Directories are opened in the
  ephemeral browser; selected files are posted to the task channel.
- Downloads the complete task working directory from the task panel's
  `📦 Download project` button. After an explicit secret-exposure confirmation,
  the Bridge includes `.git` and protected regular files, skips filesystem
  links and special entries, and posts ordered 7z volumes plus a JSON manifest.
- Downloads only the task working directory's root `.git` entry from the
  `🗃️ Download .git` button. The archive preserves `<project>/.git`, excludes
  working-tree files and nested repositories, supports normal `.git`
  directories and worktree `.git` files, and uses the same confirmation,
  link-exclusion, volume, and manifest safeguards.
- Uploads files up to the configured transfer maximum. Files above one Discord
  attachment are packaged as ordered 7z volumes and accompanied by a JSON
  manifest containing original-file and per-volume SHA-256 hashes.
- Uses the last public assistant message when an older completed turn has no
  explicit `final_answer`, instead of displaying a missing-text placeholder.
- Synchronizes the Codex task name into its Discord channel name and prefixes
  it with `🟢` while a turn is running or `⚫` while stopped.
- Synchronizes names in both directions: renaming a task channel renames the
  Codex task, then reapplies the normalized status-prefixed channel name.
- Routes command, file-change, additional-permission, user-input, and MCP
  elicitation requests to Discord buttons, selects, and modals.
- Handles app-server-backed Codex Desktop client tools for task/project
  listing, task reads, follow-up delivery, local-project task creation,
  archive/restore, rename, same-directory fork, and confirmed automation
  create/update/view/delete. Automation files are validated, written atomically
  under the current Codex home, and heartbeat targets default to the calling
  task. Desktop-only pinning, projectless/worktree creation, handoff/wait
  orchestration, interactive Desktop navigation/terminal access, and tools
  owned by external connectors fail closed with a specific reason.
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
  `deliver` input. The same input in an unbound channel under a managed project
  category first creates and binds a new task. After app-server accepts the
  input, the bridge replaces the original Discord message with the same orange
  user-card format used for Desktop input. Each input carries a stable client
  message ID, so a delayed app-server `userMessage` item no longer turns an
  accepted instruction into a false send failure; the provisional card is
  reconciled to the persisted server item ID when it arrives. One image, or one
  text file up to 200 KB, can be attached to an ordinary message. Slash commands
  remain available for explicit modes and attachments.
- Starts at Windows logon and can start the formal shared Desktop launcher when
  the app-server is absent.

## Discord commands

| Command | Purpose |
| --- | --- |
| `/codex status` | Global health, or detailed task runtime status in a task channel |
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
| `/codex model` / `reasoning` | Show or change the model and reasoning effort |
| `/codex permissions` | Show or confirm a named permission-profile change |
| `/codex mode` / `memory` | Show or change collaboration and task-memory modes |
| `/codex usage` | Show account token usage and rate-limit windows |
| `/codex resources` | Read MCP, Skills, Plugins, Hooks, or experimental inventory |
| `/codex goal` | View, set, or confirm clearing a task goal |
| `/codex compact` / `fork` | Confirm context compact or task fork |
| `/codex review` | Start inline or detached review for a selected target |
| `/codex terminals` | List or confirm termination of task background terminals |
| `/codex-files` | Browse and download files from a selected task's project root |

Each user instruction remains one orange card with `Task`, `Turn`, and `Message`
identity fields. Live commentary uses the same identity fields with a distinct
color. Long user, past commentary, and final output remains one card; its full
text is attached to that card.

Slash commands remain supported for explicit task IDs, search, attachments,
and recovery. Normal phone operation can use project/category navigation,
ordinary task-channel messages, channel rename/move, and the pinned panels
without entering a command.

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

Bots installed before pinned panels were added need one OAuth
re-authorization using the URL printed by the installer. Discord grants
**Pin Messages** separately from **Manage Messages**.

The token is stored with Windows DPAPI for the current user and a restricted
file ACL. The plaintext token exists only in the bridge child process
environment.

Small file downloads are attached directly. Large downloads require 7-Zip on
the Bridge PC; its usual installation paths are detected automatically, or an
absolute `7z.exe` path can be set as `fileShareArchiverPath`. Temporary archive
volumes are deleted after posting, and stale managed transfer directories are
removed when the Bridge starts.

Linked-file ZIP downloads use the same transfer ceiling and 7-Zip executable.
Archive entries retain their project root and relative path so links from
different projects, including same-named files, remain distinct. A SHA-256
manifest records every source file and ZIP volume.

Project archive volumes are posted one per Discord message so a slow outbound
connection does not force one request to carry several attachments. Discord
REST requests use the configurable `discordRestTimeoutMs` timeout, which
defaults to 120 seconds.

Whole-project downloads use the same configured transfer maximum for both the
source tree and produced archive. Save every posted volume in one directory
and open `.project.7z.001`; a single-volume transfer is opened as
`.project.7z`. The archive preserves the outer project folder so extraction
does not scatter its contents into the destination.

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
- Bot permissions are limited to Manage Channels, Manage Roles, Manage
  Messages, Pin Messages, View Channels, Send Messages, Embed Links, Attach
  Files, and Read Message History. Manage Roles is used only for private
  category permission overwrites; message management is used for durable cards
  and pinned control panels.
- Discord input becomes Codex turn text. There is no raw shell endpoint.
- Permission changes, compact, fork, goal removal, and background-terminal
  termination require explicit confirmation. Terminal termination accepts only
  a process ID returned by the selected task's app-server terminal inventory;
  raw PID kill is not exposed.
- Task deletion, file writes or deletion, global config mutation, and deprecated
  rollback are not exposed through Discord.
- File browsing is read-only and rooted at the selected task's working
  directory. Assistant-card downloads accept only paths that Codex actually
  linked and that resolve inside a managed project tree, a parent shared by
  managed sibling projects, or a runtime workspace root;
  arbitrary path input, UNC paths, traversal, alternate data streams, and
  symbolic links/junctions are rejected.
- Protected directories and likely secret files remain visible in the file
  index as unavailable entries. `.git`, `.codex`, credential stores,
  `.env` variants, DPAPI tokens, private-key extensions, and files containing a
  private-key header cannot be downloaded.
- `📦 Download project` is the deliberate exception to those per-file
  restrictions: after an explicit warning and confirmation, it includes every
  regular file under the task working directory, including `.git` and likely
  secrets. It still excludes symbolic links, junctions, and special filesystem
  entries, and verifies source size and modification time after archiving.
- `🗃️ Download .git` is the narrower deliberate exception. It includes only
  the root `.git` directory or worktree gitfile after warning that Git history,
  remote URLs, hooks, configuration, and credentials may be exposed. It does
  not include ordinary working-tree files or nested repositories.
- Ordinary-message input is accepted only in bound task channels or unbound
  text channels inside a managed project category, from the configured guild
  and user allowlist. Unbound control, archive, and unrelated channels never
  create tasks. It requires Discord's privileged Message Content Intent. Bot
  and webhook messages are ignored.
- Mentions are disabled in general bot output. Completion notifications allow
  only the configured `completionMentionUserId`.
- app-server remains loopback-only and is never tunneled to Discord or a LAN.
- The app-server protocol and `CODEX_APP_SERVER_WS_URL` integration are
  experimental. The formal launcher and bridge verify connectivity on every
  run.
