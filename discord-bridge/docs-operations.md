# Operations Runbook

## Normal startup

The `Codex Discord Remote` Scheduled Task starts the dedicated
`CodexDiscordRemoteHost.exe` at user logon. The host remains visible in the
notification area as **Codex Discord Remote**, and Task Manager identifies the
host by its dedicated executable name. Its tray menu provides `Show status` and
a confirmation-protected `Stop safely...` action. If the shared
app-server is absent, the bridge starts
`launcher\CodexSharedLauncher.exe` and retries with exponential backoff. The
launcher remains the owner of the Desktop/app-server lifecycle.

Use the Start menu folder **Codex Remote** for manual start, status, or graceful
stop. The bridge prevents duplicate instances with `data\bridge.lock`.

Discord can delay repeated channel-name changes. The Bridge coalesces those
updates per task without blocking its 30-second global reconciliation loop.
Use the fixed task panel's `Status` field as the immediate source when a channel
name's `🟢`/`⚫` prefix has not yet cleared Discord's rename limit. New-task
transcript backfill is serialized in the background and no longer blocks task
discovery or status reconciliation for other channels.

## Phone workflow

1. Run `/codex status` in `codex-remote`.
2. Open the project category and select the automatically synchronized task
   channel. To create a task, create a text channel in that project category
   and send its first ordinary message. The channel name becomes the task name,
   and the category selects the working directory. Archived tasks are under
   `Codex Archived`. Tasks created in Codex Desktop without selecting a folder
   are grouped under the single `Codex - No Project` category.
3. Review orange user cards, final assistant cards, and commentary cards captured
   while the task was live. `🟢` in the channel name means a turn is running;
   `⚫` means stopped. Control cards are purple, while completed result
   cards are blue.
4. Use the task panel's `💬 指示を送る` menu, or post an ordinary
   message for automatic delivery. Slash commands remain available for explicit
   task IDs, search, and attachments.
   With `plainMessageInputEnabled`, an ordinary message in the task channel is
   equivalent to `deliver`. After app-server accepts it, the original message is
   replaced with an orange user card; `❌` includes an error reply. Up to ten
   Discord attachments may be added to one ordinary message. Images are passed
   as local image inputs. PDFs, Office documents, spreadsheets, presentations,
   archives, audio, video, source files, and other regular files are stored in
   the private task-scoped runtime inbox and passed to Codex as local file
   links. An attachment-only input tells Codex to infer the intended work and
   proceed rather than stop after acknowledging the files. The same path works
   when `deliver` steers an active turn.
5. Watch the latest turn card. It shows current commentary, reasoning, and work
   state. When the next commentary starts, the previous post becomes a compact
   past card. Turn completion leaves a final card with task and turn identity,
   then reposts the unpinned task control panel directly below it.
   When app-server completes context compaction, the task channel also retains
   a separate `Codex context compacted` card with task, turn, and item identity.
   Subagents appear as read-only Discord threads under this task channel. Their
   header records nickname, agent path, depth, child ID, and parent ID. Open a
   child thread to follow its own commentary, App Server reasoning summaries,
   tools, and final response. Nested agents are flattened as sibling Discord
   threads. Finished child threads change to `⚫` and archive automatically;
   they do not create `codex-completions` posts.
6. Respond to approval or input cards when they appear.
7. Use `📁 ファイルを開く・取得` -> `プロジェクト内を見る` in the task control card to browse the task working
   directory. Select a directory to open it or a file to post it into the
   private task channel. `/codex-files` opens the same browser with explicit
   task autocomplete. On an assistant card, use `Linked files` to select a
   local file that Codex linked in its message. To retrieve the entire working
   directory, choose `プロジェクト全体を取得`, review the secret-exposure warning,
   and confirm `Archiveを作成`. To retrieve only Git metadata, tap
   `.gitだけを取得` and confirm `.gitを作成`.

## Ordinary ChatGPT workflow

1. Copy the URL of an existing ordinary ChatGPT conversation. It must contain
   `/c/<conversation UUID>` on `https://chatgpt.com`; creating a new ChatGPT
   conversation is outside this Bridge.
2. In Discord, run `/chatgpt link`, enter the URL, and optionally choose a
   display name and response performance. Only a configured authorized user can
   add or remove links.
3. Open the resulting channel under the private `ChatGPT` category and post a
   normal message. Anyone with Discord `ViewChannel` and `SendMessages` on that
   channel may execute it. The pinned green panel changes response performance;
   `🟢` means a response is running and `⚫` means ready.
4. Use `/chatgpt list`, `/chatgpt status`, or the pinned panel in
   `chatgpt-remote` to inspect the explicitly linked set. No configured default
   conversation is linked automatically.

Each send uses reviewer-accessor's exported `chat-direct-client/discord-bridge`
wrapper, shared Chrome for Testing profile, and current browser session. Discord
shows a green waiting card and replaces it with the exact recovered final answer; long output is
capped at five posts with a complete UTF-8 attachment. Documents,
source files, and archives accepted by reviewer-accessor may be attached to the
Discord input. Its current direct transport does not accept image input.
If Bridge state becomes uncertain after ChatGPT submission, the message is
marked uncertain and is not retried automatically; manually inspect the
ChatGPT conversation before deciding whether to send again.

The `Linked files` picker also provides `Download all as ZIP`. It archives all
downloadable links, preserves a project-relative path when one is available,
and posts a SHA-256 manifest with the ZIP or numbered ZIP volumes.

Linked PNG, JPEG, GIF, and WebP files that fit one Discord attachment are also
attached to their assistant card and rendered inline. The linked-file picker
remains available for downloading the original file.

Images rendered by Codex directly from tool or MCP result blocks are posted as
`Codex image` cards with native Discord image attachments. Their task, turn,
item, attachment hash, and Discord message identity are retained so duplicate
notifications and reconnect reconciliation converge on one card.

Files that fit in one attachment are posted directly. Larger files are posted
as numbered 7z volumes followed by a `.7z-manifest.json` file. Download every
volume into the same folder and open the `.7z.001` file with a 7z-compatible
phone or desktop app. The manifest records the original-file and per-volume
SHA-256 hashes.
Entries marked `🔒` remain indexed but cannot be downloaded because they are
inside a Windows-protected system directory, a filesystem link, a special
entry, or unreadable. `.git`, `.codex`, `.env`, keys, credentials, and files
outside a managed project are downloadable when Codex explicitly linked them.
The whole-project archive includes those regular files and skips symlinks,
junctions, and special filesystem entries. Download every
`.project.7z.*` volume into one folder and open `.project.7z.001`. A
single-volume transfer is opened as `.project.7z`. Extraction creates the outer
project directory. The source and produced archive have no aggregate transfer
limit; the Bridge splits the archive into `fileShareChunkBytes` volumes and
posts one volume per Discord message. `fileShareMaxBytes` continues to limit
individual-file and linked-file ZIP downloads.
The `.git`-only archive uses `.git.7z.*` volumes and a
`.git.7z-manifest.json`. Extraction creates `<project>/.git` while excluding
the rest of the working tree and nested repositories. A normal `.git`
directory and a worktree `.git` file are both accepted. Root or nested
filesystem links and special entries are never followed. The confirmation
warns that Git history, remote URLs, hooks, configuration, and credentials can
be present.
The project browser itself never leaves the task working directory. A file
explicitly linked by Codex may resolve anywhere on the local machine outside
Windows-protected system directories. This includes sibling repositories,
`.codex\visualizations`, `.codex\generated_images`, `.env`, credentials, and
other task runtime directories. Filesystem links and special entries remain
blocked, and there is no arbitrary-path input UI.

The unpinned `codex-remote` panel is kept at the latest channel position and
provides status, account usage, read-only MCP/
Skills/Plugins/Hooks/experimental-feature inventory, full sync, pending
requests, task navigation, `プロジェクト表示`, and a `履歴復元` button.
Automatic task-sync summaries are posted to the sibling `codex-sync` channel,
not to `codex-remote`; explicit sync controls continue to reply ephemerally.
Periodic reconciliation revisits active subagents only. Completed, idle, and
unloaded subagents remain in Discord and are not re-read during every
full sync; a subagent observed live still receives its normal completion update.
`プロジェクト表示` is a paged selector for hiding or restoring a complete
project mirror. Hiding requires confirmation and deletes that project's
Discord categories and all child channels (including task channels and
subagent threads), plus tracked completion notices. It does not delete Codex
task/thread data or local project files. If one of those tasks is archived
while the project remains hidden, its saved native or Desktop project identity keeps it
out of `Codex Archived` even when its current cwd no longer resolves to that
project.
Restoring recreates the mirror from App Server history; Discord-only live cards
and attachments are not recoverable.

For exceptional catch-up,
select 1, 3, or 7 days and confirm. The Bridge processes every Discord-managed
non-archived task in the background and restores completed-turn user messages,
commentary, final answers, and App Server reasoning summaries. The current
live turn stays on its single live card. Archived tasks, turns older than the
selected rolling window, and raw private reasoning content are never included.
Completion counts are posted back to `codex-remote`, after which the global
control card returns to the latest position. Each task panel groups its controls
into four menus for instructions, task management, notifications, and files.
Task management includes detailed status, task-scoped pending requests, the
advanced control center, archive/restore, and confirmed interrupt. The
notification menu combines watch level and per-task completion reports without
mixing them with execution actions. The advanced control center uses
dropdowns populated from the shared app-server for model, reasoning effort,
named permission profile, and Plan/Default mode. Its More menu includes Fast/
service tier, personality, memory, goal, context compact, fork, review, and
background terminals. Renaming the channel renames the Codex task. Moving it between its
project and archive categories remains the direct channel-level archive UI.

Permission changes, context compact, fork, goal removal, and background
terminal termination always require confirmation. A terminal can be terminated
only when it is listed by the selected task's app-server background-terminal
inventory. Discord does not expose arbitrary shell execution, raw PID kill,
task deletion, arbitrary filesystem writes or deletion, global configuration
mutation, or the deprecated rollback API. The bounded filesystem surfaces are
read-only project browsing/download and validated Codex automation files under
`$CODEX_HOME\automations`. Confirmed `codex_app/automation_update` create,
update, view, and delete calls use atomic writes and safe automation IDs.
`suggested_create` and `suggested_update` require the Desktop confirmation UI
and therefore fail closed through Discord.

Client-side dynamic tools are routed by capability rather than accepted
generically:

- Supported through app-server equivalents: `list_threads`, `read_thread`,
  `send_message_to_thread`, `list_projects`, local-project `create_thread`,
  `set_thread_archived`, `set_thread_title`, and same-directory `fork_thread`.
- Supported through the bounded local store: `automation_update`.
- Rejected with a specific reason: Desktop-only pinning, projectless/worktree
  creation, worktree/remote handoff, cursor-based background waits, Desktop
  navigation/terminal/runtime-dependency operations, unknown `codex_app` tools,
  and tools owned by external connectors.

This rejection is intentional: the Bridge does not inherit a Desktop UI
session or connector executor and never exposes a generic client-tool or shell
escape hatch.

Effectful `codex_app` client tools have one executor. When the shared launcher's
current state confirms that Codex Desktop is connected to the same app-server,
Desktop owns the request and the Bridge waits for `serverRequest/resolved` or
subsequent source-turn progress without executing it. If every recorded Desktop process is gone while the
recorded app-server generation is still alive, the Bridge provides the existing
fallback once. An unreadable, stale, or mismatched owner state fails closed
after five minutes and posts an alert; it never guesses by performing the side
effect. The app-server generation plus request ID and final Bridge response are
persisted in `data\state.json`, so reconnect delivery cannot repeat an already
attempted effect. Read-only `list_threads`, `read_thread`, and `list_projects`
remain immediately available through the Bridge.

All projects and top-level tasks are automatic. The bridge scans active and
archived task lists every 30 seconds, after reconnect, and after task lifecycle
notifications. `/codex sync` forces the same reconciliation immediately.
Notification/card mutations remain ordered within each task, but different
tasks are independent. The periodic scan avoids rewriting unchanged bindings
or project descriptors and reuses cached panel messages so background
reconciliation does not delay commands or input delivery.
Task creation from an unbound managed-project channel waits only until an
in-flight task-list read has completed; the longer channel, history, and
subagent reconciliation phases do not block the new instruction.
The bridge synchronizes both App Server native Projects and Desktop local
projects. It pages `project/list`, then unions the global task inventory with
active and archived `thread/list(projectId)` results for every native Project.
An explicit Desktop `thread-project-assignments.projectId` is authoritative.
For tasks without an explicit assignment, App Server `thread.projectId` is
preferred over Desktop root containment. Native identity uses the durable key
`app-server:<projectId>`; Desktop local-project IDs retain
their existing keys, so matching names or IDs across the two namespaces remain
distinct. Native Project names drive their Discord category names and native
Projects remain visible in `プロジェクト表示` even when they currently have no
active task channel.

For tasks without either explicit assignment or native Project identity, the
most specific saved Desktop local-project root containing the cwd is used.
Multiple roots and scratch cwds belonging to one local project therefore share
one category. Empty superseded project categories are removed after migration.
Project category names are refreshed from their authoritative Project name on
every synchronization. A deterministic suffix is kept only while another
managed project category has the same name; it is removed automatically once
that collision is gone. Hiding applies independently to both native and local
identity keys, and project-scoped enumeration prevents a hidden native task
omitted from the global list from reappearing in Discord or `Codex Archived`.
Moving a task channel into `Codex Archived` archives the matching Codex task.
Moving an archived channel back to its own project category unarchives it.
Moving it to any unrelated category is rejected and immediately rolled back to
its recorded category without changing the Codex task state.

An unbound channel becomes a task only when it is inside a managed project
category. The first valid post creates and binds one task before delivery;
follow-up posts in that channel are processed in order. Control, archive, and
unrelated categories do not create tasks from ordinary messages.

`Others` / `transfer-text` is a separate local text inbox, not a task channel.
It accepts a body from an authorized human or Discord webhook and stores it
verbatim as UTF-8 at `data\transfer-text\<timestamp>.txt`. The timestamp is a
numeric millisecond value. Exactly one generated `.txt` file is kept: after a
new file is safely written, the previous timestamped file is removed and the
source Discord message is deleted. If the local write fails, the Discord
message remains for recovery. Other bots are ignored, and attachments or
embeds without a message body are not stored or sent to Codex.

Each ordinary Discord task-channel message received after this outbox version
is running is first written atomically to
`data\delivery-outbox\<sha256(requestId)>.json`. Its request ID is derived from
the exact guild, channel, and Discord message IDs and is also sent as the
app-server `clientUserMessageId`. Existing Discord history is never imported,
so the first outbox-enabled start writes a `recovery-cursor.json` cutover and
does not execute messages at or before it. Later app-server reconnects, Discord
gateway resumes, and Bridge restarts scan each visible active task channel
after its persisted cursor and enqueue missed post-cutover messages in order.

Before mutation, the drain reads the exact target and active turn. It then
persists one `attempting` record and issues exactly one `turn/start` or
`turn/steer`. A matching request/attempt receipt and exact turn ID are written
atomically before the success reaction is attempted. If the Bridge disconnects
before the mutation begins, the entry remains `queued` and is retried after
subscription restoration. If acceptance is uncertain after mutation begins,
the entry becomes `uncertain`: reconnect performs a bounded full-item history
lookup for the request ID, but absence is not treated as proof that retry is
safe and the instruction is not resent. Stale, hidden, archived, reassigned,
overlapping, corrupt, and request-ID/payload-mismatch cases fail closed.

The terminal Discord reaction callback has its own persisted attempt and can
be claimed only once. A crash during that callback becomes callback
`uncertain`, rather than repeating an external effect. After accepted delivery,
the orange user card is posted even if the persisted `userMessage` notification
is delayed by active tool work. When that notification arrives, its `clientId`
replaces the provisional identity with the server item ID on the existing card.
Slash-command delivery remains immediate and is not imported into this ordinary
message outbox.

When a turn completes and that task's completion-report setting is ON,
`codex-completions` starts by mentioning the configured user with
`タスクが完了しました。`, puts a one-line final-answer summary on the second
line, and uses the bare completion-message URL as the final line so Discord
renders its channel-aware compact form. The setting defaults to ON. Selecting
OFF in the task control card leaves final cards in the task channel but skips
future completion posts, including reconnect recovery for turns completed
while OFF.

`normal` is the default watch level. `quiet` keeps only completions, errors,
and requests in the task view. `verbose` adds all item and token details to the
live view. The completion-report selector independently controls
`codex-completions` posts.

## Connection recovery

The Discord gateway and Codex app-server both reconnect automatically. When
app-server reconnects, every visible, non-archived task is resumed serially on
the same server and only the bounded recent full turns needed for live-card and
missed-completion repair are loaded. Task-list reconciliation and outbox drain
wait until that subscription restoration is ready, preventing concurrent bulk
RPC load from repeatedly closing the shared WebSocket. Global, active,
archived, and native-project inventories are fetched serially. A parent task's
first subagent discovery still scans its complete history; later scans preserve
the known child IDs and inspect only the newest ten full turns for additions.
Historical
reconciliation backfills user cards and final assistant cards only. Commentary
is captured while the turn is actively subscribed; already-persisted
commentary cards are preserved by task, turn, and item identity.
Transient gateway, REST, app-server, attachment-fetch, DNS, TCP, and TLS
failures do not terminate the Bridge even if they reach the process error
boundary. Initial Discord login and setup retry with exponential backoff capped
at five minutes. Authentication, certificate, configuration, and programming
errors remain fatal and rely on the scheduled-task restart policy.
The confirmed `履歴復元` control is the only bounded exception: it can backfill
commentary and available reasoning summaries for completed turns from the last
1, 3, or 7 days across non-archived managed tasks.
A completed turn not matching the binding's last known turn ID is posted as a
missed completion before normal streaming resumes, unless completion reporting
was OFF for that task. Suppressed turns are marked handled and are not posted
later after the setting is re-enabled. Final and notification message IDs are
persisted separately, and visible identity markers are checked during recovery,
so interruption between Discord delivery and local state persistence does not
duplicate a turn.

Use `Get-DiscordBridgeStatus.ps1` when the bot appears offline. Relevant files:

- `data\runtime.json`: process, Discord, and app-server status.
- `data\state.json`: project/category, task/channel, and turn/message identity
  bindings plus completion-notice IDs.
- `data\delivery-outbox\*.json`: post-deployment ordinary-message delivery,
  exact-attempt receipt, uncertainty, and one-shot reaction-callback state.
- `data\delivery-outbox\recovery-cursor.json`: the immutable initial cutover
  plus the last examined post-cutover Discord message ID per task channel.
- `data\transfer-text\<timestamp>.txt`: latest authorized user or webhook text
  posted to `Others` / `transfer-text`.
- `logs\bridge-YYYYMMDD.jsonl`: process lifecycle.
- `logs\codex-YYYYMMDD.jsonl`: app-server RPC lifecycle metadata.
- `logs\discord-YYYYMMDD.jsonl`: command and interaction metadata.

No log includes prompt bodies, approval answers, or the bot token.

## Credential rotation

Reset the token in Discord Developer Portal, then rerun
`Install-DiscordBridge.ps1` with the same Application ID and Server ID. The
installer replaces the DPAPI-protected token, revalidates commands, and updates
the Scheduled Task without changing task/channel bindings.

## Uninstall

```powershell
.\Uninstall-DiscordBridge.ps1
```

This performs graceful stop, removes the Scheduled Task and Start menu
shortcuts, and preserves configuration by default. Add `-RemoveConfiguration`
to remove the protected token and local configuration. Source, logs, and task
bindings remain available for diagnosis.
