# Codex Discord Remote

This is a private Discord control surface for the shared Codex Desktop
app-server. It keeps the app-server on `127.0.0.1`; only the bot makes an
outbound connection to Discord.

## Capabilities

- Creates a private `Codex Control` category with `codex-remote`, `codex-sync`,
  alert, and completion channels. Automatic task-sync summaries go to
  `codex-sync`, so they do not push the latest control surface down the
  `codex-remote` timeline.
- Creates `chatgpt-remote` in the control category and a separate private
  `ChatGPT` category for ordinary ChatGPT conversations. Only URLs explicitly
  registered with `/chatgpt link` are listed; the Bridge does not discover,
  auto-link, create, rename, or archive ChatGPT-side conversations. Each linked
  conversation has one status-prefixed Discord channel and a pinned green
  control panel. Normal messages are serialized through the sibling
  `reviewer-accessor` checkout, while a durable Discord-message ledger prevents
  gateway replay from submitting the same ChatGPT turn twice.
- Creates one private category per project and continuously synchronizes every
  top-level Codex task into its project category. Tasks without a folder selected
  in Codex Desktop share one private `Codex - No Project` category, even when the
  App Server assigns them separate generated working directories.
- Periodic full-task reconciliation refreshes only active Codex subagents.
  Completed, idle, and unloaded subagents already known to the Bridge remain in
  their existing Discord threads without being re-read on every cycle; live
  completion handling still finalizes a subagent that was observed while active.
- Treats the first ordinary message in an unbound text channel inside a managed
  project category as a new task request. It starts the task in that project's
  working directory, derives its title from the channel name, binds the same
  channel, and serializes rapid follow-up messages to prevent duplicate tasks.
- Creates a private `Others` category with a `transfer-text` channel. Messages
  from configured authorized users or Discord webhooks are written verbatim as
  UTF-8 to `data/transfer-text/<timestamp>.txt`; only the newest timestamped
  text file is retained. The source Discord message is deleted only after the
  local write succeeds. This inbox does not create or deliver a Codex task.
- Keeps one unpinned control card as the latest message in `codex-remote` and
  uses unpinned control cards in every task channel. The global panel exposes status, account usage, read-only Codex
  resource inventory, full sync, pending requests, project visibility, and task navigation. Task
  panels expose delivery mode, watch level, a per-task `codex-completions`
  report toggle, detailed status, task-scoped pending requests, a task control
  center, archive/restore, and confirmed interrupt, plus a paged project-file
  browser. Control panels use a dedicated purple embed color; completed result
  cards remain blue.
- Provides a paged `プロジェクト表示` selector. After explicit confirmation,
  hiding a project deletes its Discord categories and all child channels
  (including task channels and subagent threads), plus tracked completion notices, while leaving Codex task/thread data
  and local files untouched. Hidden projects are omitted from task discovery,
  history restoration, live mirroring, subscriptions, completion reports, and
  `Codex Archived`; archiving a hidden task does not recreate its Discord mirror.
  Selecting the hidden project again recreates its Discord mirror from the
  history still available through the shared app-server; Discord-only live
  cards and attachments cannot be restored.
- Offers a confirmed `履歴復元` exception from the global panel. The user
  selects 1, 3, or 7 days; the Bridge then restores completed-turn user,
  commentary, final-answer, and available reasoning-summary cards for every
  Discord-managed non-archived task. Raw private reasoning content, archived
  tasks, older turns, and the current live turn are excluded.
- Reposts the unpinned task control panel immediately below each terminal turn
  card. The previous bot-owned task panel is removed only after the replacement
  ID is persisted, so mobile users always find controls at the latest position.
- Groups the fixed task panel into four mobile-friendly dropdowns: send an
  instruction, manage the task, configure notifications, and browse or download
  files. Dangerous and secret-bearing actions keep their existing confirmation
  steps, and legacy button IDs remain accepted while old panels are replaced.
  The first synchronization after Bridge startup also reconciles every stored
  visible task panel, including archived tasks outside the normal bounded
  history-sync window.
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
  message starts. After each accepted user input, it immediately reposts the
  running card below the user card instead of waiting for the app-server echo.
  Historical and reconnect reconciliation does not backfill
  commentary cards; it synchronizes user messages and final answers only.
  Completion recovery is serialized per turn and never recreates a missing
  commentary card after that turn's final card has been persisted. Late
  turn-scoped live notifications are also ignored once the final card exists.
  `履歴復元` is the bounded, confirmation-protected exception described above.
- Shows current commentary, reasoning, plans, tool progress, and token usage
  only on the latest card. A past commentary card contains only its title,
  message, task ID, turn ID, and message ID; a final card uses task and turn ID.
- Persists every completed app-server `contextCompaction` item as its own task
  card with task, turn, and item identity. The item-to-Discord-message mapping
  prevents reconnect or duplicate live notifications from posting it twice.
- Persists image blocks returned by app-server tool/MCP items as Discord image
  attachments on a dedicated `Codex image` card. The task, turn, and item
  identity prevents duplicate posts, and a hydrated `thread/read` restores a
  missing image card after reconnect without persisting the base64 payload in
  Bridge state.
- Adds a `Linked files` button to assistant cards that contain Markdown links
  to absolute local Windows files. A linked regular file may be anywhere on the
  local machine except a Windows-protected system directory, and the selected
  file is posted to its private task channel. The same picker offers
  `Download all as ZIP`, which packages every downloadable link. Linked PNG,
  JPEG, GIF, and WebP files that fit one Discord attachment are also attached
  directly to the assistant card so Discord renders the image inline.
- Browses one directory level at a time from a task's project root through
  `📁 ファイルを開く・取得` -> `プロジェクト内を見る` or `/codex-files`. Directories are opened in the
  ephemeral browser; selected files are posted to the task channel.
- Allows explicitly linked artifacts under `.codex/visualizations`,
  `.codex/generated_images`, other task runtime directories, sibling projects,
  and arbitrary local development directories. The Bridge does not expose an
  arbitrary-path input UI.
- Downloads the complete task working directory from `📁 ファイルを開く・取得`
  -> `プロジェクト全体を取得`. After an explicit secret-exposure confirmation,
  the Bridge includes `.git` and protected regular files, skips filesystem
  links and special entries, and posts ordered 7z volumes plus a JSON manifest.
- Downloads only the task working directory's root `.git` entry from
  `📁 ファイルを開く・取得` -> `.gitだけを取得`. The archive preserves `<project>/.git`, excludes
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
- Reconnects indefinitely, restores visible non-archived task subscriptions
  serially with bounded recent turns, then releases outbox and task-list work;
  reconciles persisted message IDs with visible Discord IDs and reports missed
  completions. Task inventories are fetched serially, and a parent task that
  already completed one full subagent scan preserves known children while
  scanning only its newest ten turns for additions.
- Treats transient communication failures across the Discord gateway, Discord
  REST, Codex app-server WebSocket, attachment fetches, DNS, TCP, and TLS as
  recoverable. Initial Discord login and setup retry with exponential backoff
  up to 300 seconds; a network timeout reaching the process error boundary is
  logged without terminating the Bridge. Authentication, certificate,
  configuration, and programming errors remain fatal.
- Uses `reviewer-accessor`'s explicit conversation URL, response-performance,
  cross-process turn lock, shared Chrome-for-Testing profile, and exported
  `chat-direct-client/discord-bridge` wrapper for ordinary ChatGPT. The Bridge
  resolves that package export instead of importing Accessor transport internals.
  Authentication remains in the current browser profile; the Bridge never copies
  tokens into its config, state, command line, or logs. Supported outgoing attachments follow the
  reviewer contract: ordinary documents, source files, and archives are
  accepted; image input is rejected before submission. A post-submission
  failure is marked uncertain and is never automatically retried.
- Renders ordinary ChatGPT answers as native Discord Markdown instead of Codex
  task cards. It keeps balanced fenced code blocks across roughly 1,800-character
  pages, shows up to nine pages inline, and attaches a complete
  `chatgpt-answer.md` when the response is longer. Returned images are uploaded
  as their own Discord image posts, other returned files are attached separately,
  and files above the direct-upload size use the existing split-7z transfer with
  a SHA-256 manifest. Per-file acquisition failures are displayed instead of
  silently dropping the file. Caller-owned materialized files are removed only
  after every corresponding Discord post succeeds.
- Adds `最近5ターン同期` to each explicitly linked ChatGPT channel. The button
  performs one read-only persisted-history request, renders only user text and
  exact durable assistant finals, and upserts by the stable
  `(conversationId, turnId)` key. Repeated syncs and an incomplete-to-completed
  transition edit the existing two-message projection instead of duplicating it.
- When completion reporting is enabled for the task, mentions the configured
  user with `タスクが完了しました。` on the first line in `codex-completions`,
  posts a one-line final-answer summary on the second line, and uses the bare
  Discord message URL as the final line. Existing and new tasks default to ON;
  OFF suppresses future completion posts without removing task-channel results
  or producing delayed reports after reconnect.
- Reconciles active and archived task lists every 30 seconds, after reconnect,
  and immediately after task lifecycle notifications.
- Preserves notification order within one task while allowing different tasks
  to progress independently. Periodic reconciliation skips unchanged durable
  state writes and reuses cached control panels, and Discord input delivery does
  not wait for its decorative progress reaction. Creating a task from an
  unbound project channel waits only for the in-flight task-list snapshot, not
  for later Discord or subagent reconciliation.
- Treats ordinary messages from allowed users in bound task channels as Codex
  `deliver` input. The same input in an unbound channel under a managed project
  category first creates and binds a new task. Each message received after this
  version is running is atomically queued under `data\delivery-outbox` before
  App Server mutation. The first start records a recovery cutover without
  importing older Discord history; later reconnects and restarts scan forward
  from each task channel's persisted cursor, so post-cutover messages received
  while the Bridge was unavailable are queued in order. A message
  that has not reached mutation is delivered after reconnect, while an
  acceptance-uncertain attempt is reconciled by exact request ID and is never
  automatically resent merely because bounded history did not find it. Stale
  targets, overlap, corrupt state, and request-ID replacement fail closed.
  After app-server accepts the
  input, the bridge replaces the original Discord message with the same orange
  user-card format used for Desktop input. Each input carries a stable client
  message ID for correlation, not server-side deduplication, so a delayed
  app-server `userMessage` item no longer turns an
  accepted instruction into a false send failure; the provisional card is
  reconciled to the persisted server item ID when it arrives. Success/error/
  uncertain reactions use a separately persisted, one-attempt callback receipt.
  An ordinary
  message may carry up to ten Discord attachments. Images become app-server
  `localImage` inputs; PDFs, Office documents, archives, audio, video, source
  files, and other regular files are stored in the task-scoped runtime inbox
  and passed to Codex by absolute local file link. The files are never
  executed by the Bridge. An attachment-only message asks Codex to infer the
  intended analysis, answer, or work and proceed instead of merely confirming
  receipt. Attachments can also steer an active turn. Slash
  commands remain available for explicit immediate modes and a single
  attachment; they are not imported into the ordinary-message outbox.
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
| `/chatgpt link` | Explicitly link one existing ordinary ChatGPT conversation URL |
| `/chatgpt list` | List only explicitly linked ChatGPT channels |
| `/chatgpt status` | Inspect reviewer-accessor and linked-conversation session state |

Each linked conversation panel also provides `最近5ターン同期`. It never sends a
Chat message and does not retry a failed history read.

Each user instruction remains one orange card with `Task`, `Turn`, and `Message`
identity fields. Live commentary uses the same identity fields with a distinct
color. Long user, past commentary, and final output remains one card; its full
text is attached to that card.

Slash commands remain supported for explicit task IDs, search, attachments,
and recovery. Normal phone operation can use project/category navigation,
ordinary task-channel messages, channel rename/move, and the control cards
without entering a command.

Incoming files are stored under
`data/incoming-files/<task-id>/<Discord-message-id>/`. They persist so resumed
tasks can still open paths recorded in their history and are excluded from
Git. `inputAttachmentMaxCount`, `inputAttachmentMaxBytes`, and
`inputAttachmentTotalMaxBytes` bound the count, individual size, and total size
for one Discord input. Defaults are 10 files and 512 MB for both size limits;
Discord's guild/account upload limit normally applies first.

The state schema is the durable lookup table:

- project ID -> one or more Discord category IDs;
- hidden project ID -> descriptor and Discord-mirror exclusion state;
- Codex task ID -> Discord task channel ID;
- Codex subagent thread ID -> its parent task ID and Discord thread ID;
- Codex turn ID -> user, live commentary, final, and completion-notice message IDs;
- context-compaction item ID -> its durable Discord task-card message ID;
- explicit ChatGPT conversation ID -> Discord channel and Discord input/output message IDs.

Before sending during recovery, the bridge checks both that ledger and visible
message identity markers. A restart after Discord accepted a post but before
local state was written therefore converges on the existing post instead of
creating a second copy.

No project registration is required. The bridge follows every page of
`project/list`, the global active and archived `thread/list` views, and the
active and archived `thread/list(projectId)` views for every App Server native
Project. The project-scoped inventory is merged by task ID because native
Project tasks are not guaranteed to appear in the global list. An explicit
Desktop `thread-project-assignments.projectId` remains authoritative; for an
unassigned task, App Server `thread.projectId` takes precedence over Desktop
root containment. Native keys use an `app-server:` namespace so same-name or
same-ID local and native Projects cannot collapse into one Discord category
identity. Both identity namespaces appear in `プロジェクト表示` and can be hidden independently.
User-owned top-level tasks are synced;
ephemeral tasks remain inside their parent representation. A Codex subagent is
mirrored as a Discord thread under its top-level parent task channel. Its agent
path, nickname, depth, commentary, App Server reasoning summaries, tool progress,
and final answer stay in that thread. Nested agents are flattened under the same
top-level task channel because Discord cannot nest threads. The mapping is
persisted by child thread ID, recovered from parent history after reconnect, and
kept read-only; Discord posts inside a subagent thread are not delivered to
Codex. Finished subagent threads use the stopped marker and are archived without
posting to `codex-completions`. Discord category overflow is sharded automatically
when a category reaches 50 channels.
Desktop local-project fallback and folder containment are read from Codex
Desktop's `.codex-global-state.json`. If that file cannot be read and a task has
no native App Server Project identity, the bridge falls back to the App Server
`cwd` category behavior instead of treating every task as projectless.

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

Enable **Message Content Intent** on the application's **Bot** page in Discord
Developer Portal. The `Others` / `transfer-text` inbox requires it. Installing
with `-EnablePlainMessageInput` additionally permits ordinary task-channel
messages to become Codex instructions.

The root installer first builds and installs the shared Desktop launcher and
the dedicated `CodexDiscordRemoteHost.exe`, then
validates the token and server, defaults `authorizedUserIds` to the server owner,
registers guild-scoped commands, installs a current-user Scheduled Task, starts
Desktop and the Bridge, and verifies that both use the same app-server. The
standalone `Install-DiscordBridge.ps1` remains available for Bridge-only repair
after the shared launcher has already been installed.

The host appears as **Codex Discord Remote** in the notification area and as
`CodexDiscordRemoteHost.exe` in Task Manager, instead of leaving the Bridge
identified only by generic PowerShell and Node processes. Its notification-area
menu exposes status and a confirmed graceful stop; stopping it does not stop
Codex Desktop or the shared app-server.

Bots installed before pinned ChatGPT panels were added need one OAuth
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
Discord TCP/TLS connection establishment uses `discordConnectTimeoutMs`, and
REST responses use `discordRestTimeoutMs`. Both default to 300 seconds and are
clamped to a minimum of 300 seconds. A failed `turn/completed` delivery is
re-read from the app-server and retried idempotently, while periodic task sync
also repairs stopped tasks whose Discord turn record is still `inProgress`.
Codex app-server WebSocket establishment and operation requests also wait up to
300 seconds before timing out. Transient timeout, disconnect, DNS, socket, and
fetch errors share one recovery classification regardless of which transport
reported them.

Task status reconciliation does not wait for Discord's comparatively slow
channel-name rate-limit bucket. Channel name/topic updates are coalesced per
channel in the background, while task panels, bindings, and every other task
continue synchronizing. The task panel is therefore the authoritative immediate
status display if an `🟢`/`⚫` channel-name prefix is temporarily delayed by
Discord. Initial transcript backfill also runs behind task discovery, so one
long history cannot hold the global task list stale.

Whole-project and `.git` downloads do not have an aggregate source or archive
limit. They are split into volumes no larger than `fileShareChunkBytes` and
posted one volume per Discord message. Save every posted volume in one
directory and open `.project.7z.001`; a single-volume transfer is opened as
`.project.7z`. The archive preserves the outer project folder so extraction
does not scatter its contents into the destination. `fileShareMaxBytes` still
limits individual-file and linked-file ZIP downloads.

## Operations

```powershell
.\Get-DiscordBridgeStatus.ps1
.\CodexDiscordRemoteHost.exe
.\Stop-DiscordBridge.ps1
```

Use the dedicated host or the **Codex Remote** Start menu shortcut for normal
manual startup. `Start-DiscordBridge.ps1` is the host's internal child-process
entry point and is retained for diagnostics.
`Stop-DiscordBridge.ps1` writes a stop request and waits for a clean shutdown.
It deliberately does not use `Stop-Process`.

Logs are append-only JSONL under `logs/`. Runtime state and task/channel
bindings are atomically persisted under `data/`. The latest accepted text-inbox
message is stored under `data/transfer-text/`. None of these locations contains
the Discord bot token.

Effectful `codex_app` client-tool requests use Codex Desktop as the exclusive
executor whenever the shared launcher confirms a live Desktop on the same
app-server. The Bridge is a fallback only when Desktop is confirmed absent.
Ambiguous ownership waits five minutes and then fails closed with an alert.
App-server generation/request IDs and Bridge outcomes are persisted so a
reconnect cannot repeat an effectful fallback. Read-only client tools are not
delayed by this arbitration. A delegated request is closed locally when the
app-server reports either explicit resolution or subsequent progress in its
source turn.

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
  and durable control cards.
- Discord input becomes Codex turn text. There is no raw shell endpoint.
- Permission changes, compact, fork, goal removal, and background-terminal
  termination require explicit confirmation. Terminal termination accepts only
  a process ID returned by the selected task's app-server terminal inventory;
  raw PID kill is not exposed.
- Task deletion, arbitrary file writes or deletion, global config mutation, and
  deprecated rollback are not exposed through Discord. The fixed
  `data/transfer-text` latest-message inbox is the bounded write exception.
- File browsing is read-only and rooted at the selected task's working
  directory. Assistant-card downloads accept any absolute local regular-file
  path that Codex actually linked, including `.git`, `.codex`, credential
  stores, `.env`, DPAPI tokens, private-key files, and files outside managed
  projects. Windows-protected system directories, arbitrary path input, UNC
  paths, alternate data streams, symbolic links/junctions, and special
  filesystem entries remain unavailable.
- `📦 Download project` requires an explicit warning and confirmation before
  archiving every regular file under the task working directory. It excludes
  symbolic links, junctions, and special filesystem entries, and verifies
  source size and modification time after archiving.
- `🗃️ Download .git` is the narrower deliberate exception. It includes only
  the root `.git` directory or worktree gitfile after warning that Git history,
  remote URLs, hooks, configuration, and credentials may be exposed. It does
  not include ordinary working-tree files or nested repositories.
- Ordinary-message input in a bound task channel follows Discord's effective
  channel permissions: a human with both `ViewChannel` and `SendMessages` may
  execute that task. `authorizedUserIds` in `config/config.json` is the separate
  Codex Remote operator list for control-plane commands and for creating a task
  from the first message in an unbound managed-project channel. Other users are
  rejected and their content is never sent to Codex. Unbound control, archive,
  and unrelated channels never create tasks. It requires Discord's privileged
  Message Content Intent. Bot and webhook messages are ignored in task channels.
  Existing category permission overwrites remain owned by Discord administrators;
  newly created managed categories copy the current control or parent category.
- Ordinary-message input in an explicitly linked ChatGPT channel uses the same
  effective `ViewChannel` plus `SendMessages` rule. Only `authorizedUserIds` may
  run `/chatgpt link` or confirm unlinking. A linked channel never grants access
  to other ChatGPT conversations and never changes the ChatGPT-side lifecycle.
- Incoming attachments are downloaded only from Discord's attachment URL after
  the guild and user checks pass. The Bridge does not execute them. Files are
  stored under `data/incoming-files/<task-id>/<Discord-message-id>/`, remain
  available to resumed task history, and are ignored by Git. Defaults allow at
  most 10 files and 512 MB per file/message; Discord's own upload limit applies
  first. Operators may lower these with `inputAttachmentMaxCount`,
  `inputAttachmentMaxBytes`, and `inputAttachmentTotalMaxBytes`.
- The sole webhook exception is the configured `Others` / `transfer-text`
  channel. It accepts messages from any Discord webhook or an authorized human,
  ignores other bot messages, and writes only the message body to the fixed
  runtime inbox. Embeds and attachments are not stored. A successful write
  creates one numeric millisecond timestamp `.txt` file and removes the prior
  timestamped text file, then deletes the source Discord message. A failed
  local write leaves the Discord message in place.
- Slash commands and controls in the control plane require `authorizedUserIds`.
  Task-channel commands, buttons, selects, and modal submissions accept either
  an operator or a user with the same effective task-channel permissions. A
  non-operator cannot target a different task by supplying its thread ID.
  Completion recipients are configured independently through
  `completionMentionUserIds`. Turn executors are recorded for audit and
  deduplication but are not mentioned automatically.
- Mentions are disabled in general bot output. Completion notifications allow
  only configured `completionMentionUserIds`; an empty list disables mentions.
- app-server remains loopback-only and is never tunneled to Discord or a LAN.
- The app-server protocol and `CODEX_APP_SERVER_WS_URL` integration are
  experimental. The formal launcher and bridge verify connectivity on every
  run.
