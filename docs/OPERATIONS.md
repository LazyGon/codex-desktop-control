# Operations

## Start the shared Desktop

1. Quit any normally started Codex Desktop.
2. Start **Codex Shared Server** from the Start menu or taskbar.
3. The launcher either starts the shared app-server or validates and reuses the
   healthy app-server already owned by this checkout. The package's app-server
   and Code Mode host are cached together by package version and hash-checked
   before startup or reuse. It reconciles managed
   project paths and task assignments while Desktop is still stopped, and then
   starts Desktop.
4. Wait for two ascending tones. They mean the Desktop connection to the
   shared app-server was verified.
5. Two descending tones on exit mean an app-server owned by that launcher
   session and its transient environment were cleaned up. A Desktop-only attach
   does not take over or clean up the existing server.

When the Store updates `OpenAI.Codex` during a shared session, the launcher
recognizes the replacement package and pauses every goal whose current status
is `active`. It keeps the old shared app-server alive until all active turns
have drained, then replaces the Desktop and app-server together. After the new
shared connection is verified, it resumes only the goals that this update
paused. Goals already paused, blocked, limited, or complete are not changed.
After a Windows logon, the Discord Remote host starts the shared launcher before
the full Bridge cold start when `autoStartSharedDesktop` is enabled. Manual
launch is not required after an app update or reboot.

The most recent reconciliation result is stored in
`launcher\state\project-sync-last.json`. Backups of the Desktop global state
are stored in `launcher\state\project-sync-backups\`. A reconciliation failure
stops startup before Desktop opens, so the existing Desktop state is not
silently replaced or partially updated. On a first installation, reconciliation
is skipped until both Desktop and Bridge have created their initial state files.

Launcher self-tests use a port-specific runtime-state file and never replace
the live `launcher\state\current.json`.

For a one-shot offline repair, use
`launcher\Restart-CodexSharedWithProjectRepair.ps1` from a detached hidden
PowerShell process. It waits for the named active task to finish before
stopping anything, revalidates the live Desktop connection and listener owner,
stops the Bridge through its graceful request, requests a normal Desktop close,
and keeps the owned app-server alive while Desktop is replaced. If the verified
Desktop root remains alive after the normal close timeout, the repair terminates
only that exact root PID after rechecking its executable and command line. It
then starts the shared launcher in Desktop-only reuse mode and restarts the
Bridge. `-WaitForThreadId` names the current task that must finish first;
`-VerifyThreadId` names the task whose repaired project assignment must be
proved after Desktop reattaches. The final result is written to
`launcher\state\project-repair-last.json`.

For an already-running shared runtime whose package version is stale, use
`launcher\Refresh-CodexSharedRuntime.ps1` from a detached hidden PowerShell
process. Supply the exact active thread and turn plus the current and target
package versions. It pauses active goals before waiting, stops Bridge ingress,
waits for every active turn, replaces the old owned server, verifies the new
Desktop connection and hashes, restores only updater-paused goals, restarts the
Bridge, and sends one completion callback. Its finite receipt is written to
`launcher\state\runtime-refresh-last.json`.

## Discover and catch up a phone-created task

From the repository root, use:

```powershell
.\control\codex-control.cmd list --limit 10
.\control\codex-control.cmd catchup latest
```

Use an explicit thread id when more than one recent task is relevant:

```powershell
.\control\codex-control.cmd catchup THREAD_ID --messages 20
```

The catch-up result includes task metadata and recent user/assistant messages.
It does not mutate the target task.

## Control another task

Start a new turn on an idle task:

```powershell
.\control\codex-control.cmd send THREAD_ID --message "MESSAGE"
```

Steer the currently active turn:

```powershell
.\control\codex-control.cmd steer THREAD_ID --message "MESSAGE"
```

Choose `steer` for an active task and `send` for an idle task automatically:

```powershell
.\control\codex-control.cmd deliver THREAD_ID --message "MESSAGE"
```

Interrupt only after explicitly identifying the target task:

```powershell
.\control\codex-control.cmd interrupt THREAD_ID
```

## Wake the current UI task after its active turn

Arm from a background process while the target turn is still active:

```powershell
.\control\codex-control.cmd wake-after-turn THREAD_ID --message "MESSAGE" --marker UNIQUE_MARKER
```

The controller waits for the exact active turn id to complete, beeps, starts a
new turn on the same app-server, verifies `turn/started`, and writes atomic
state under `state/`. Because Desktop is connected to that same server, its UI
receives the live turn notifications without an application restart.

## Safety boundaries

- Never stop a listener until its port, PID, executable, command line, parent,
  and active clients have been checked.
- Never stop the app-server currently used by Codex Desktop.
- Use explicit thread ids for destructive or interrupting operations.
- `catchup` and `list` are read-only. `send`, `steer`, `deliver`, and
  `interrupt` mutate the selected task.
- The CLI preserves each task's existing approval, sandbox, and workspace
  configuration instead of replacing it.

## Discord remote operation

The formal phone-facing control surface is under `discord-bridge\`. It uses the
same shared app-server. `codex-remote` is the control-plane channel, each
project receives a private category, every top-level task is synchronized
automatically, and archived tasks move to `Codex Archived`. Installation,
commands, approval routing, reconnection behavior, and credential rotation are
documented in `discord-bridge\README.md` and `discord-bridge\docs-operations.md`.
Automatic task-sync summaries are posted to `codex-sync` rather than
`codex-remote`. The unpinned global control card is also replaced after any
persistent `codex-remote` message so it remains at the latest timeline position.

Ordinary ChatGPT conversations are a separate explicit surface. Run
`/chatgpt link` with an existing `https://chatgpt.com/.../c/<UUID>` URL; the
Bridge then creates one channel under the private `ChatGPT` category. It never
discovers or links the default reviewer conversation automatically. Messages in
that channel use `reviewer-accessor`'s exported `chat-direct-client/discord-bridge`
wrapper and current-user Chrome profile, not the Codex app-server. `/chatgpt list` and the pinned
`chatgpt-remote` panel enumerate only explicitly linked conversations.

To create a Codex task from a phone, create a text channel inside the target
project category and send its first ordinary message. The Bridge uses the
category's stored project path for `thread/start`, derives the task name from
the channel name, binds the existing channel, and delivers that message as the
first turn. Rapid messages in the same channel are serialized, so only one task
is created. Unbound channels in the control, archive, or unrelated categories
are ignored rather than becoming tasks.

Use the latest control card in `codex-remote` for connection status, account usage,
read-only Codex resource inventory, full sync, pending requests, task
navigation, and bounded recent-history recovery. Select `履歴復元`, choose 1,
3, or 7 days, and confirm to restore completed-turn user messages, commentary,
final answers, and available App Server reasoning summaries for every
Discord-managed non-archived task. This is an explicit exception to normal
history reconciliation; it never includes archived tasks, data older than
seven days, raw private reasoning content, or the current live turn. Every task
channel has its own unpinned control card for delivery mode,
watch level, detailed status, pending requests, the task control center,
archive/restore, and confirmed interrupt. The control center uses app-server
catalogs for model, reasoning, permissions, and Plan/Default mode. Its More
menu exposes Fast/service tier, personality, memory, goal, compact, fork,
review, and background terminals. Rename a task channel to rename the
Codex task. The next sync normalizes the channel name and restores its status
emoji prefix.

When a task starts subagents, each child appears as a read-only Discord thread
under the top-level task channel. Open that thread to follow the child's
commentary, App Server reasoning summaries, tool progress, and final response.
Nested children are listed as sibling Discord threads with their path and depth
shown in the header. `🟢` means the child is running; `⚫` means it has finished.
Finished child threads are archived but remain readable. Messages posted inside
these mirror threads are intentionally not sent to Codex.

Assistant-card `Linked files` pickers provide individual downloads and a
`Download all as ZIP` action. Explicitly linked regular files may be anywhere
outside Windows-protected system directories, including `.codex`, `.git`,
`.env`, credential files, and paths outside managed projects. Filesystem links,
special entries, and unreadable files remain excluded and visible as locked
items.

Permission changes, compact, fork, goal removal, and background-terminal
termination require an explicit confirmation. Terminal termination is limited
to processes returned by `thread/backgroundTerminals/list`; there is no raw
PID kill or arbitrary shell endpoint. Task deletion, filesystem mutation,
global config mutation, and deprecated rollback are intentionally absent from
the Discord control surface.

For every subscribed task, user instructions entered in Codex Desktop are
posted to the matching private Discord task channel as orange cards with
`Task`, `Turn`, and `Message` identity fields. Project/category, task/channel,
and turn/message IDs are persisted together. Instructions sent from Discord are
linked to the same turn ledger and, after app-server accepts them, the original
Discord message is replaced with the same user-card format. On reconnect, the
bridge reconciles task history against both persisted message IDs and visible
identity fields. Long user and final-answer text remains one card, with the full
text attached when necessary.

Every assistant turn uses one card. The latest card shows current commentary,
reasoning, plans, tool progress, and token usage. On completion the same post
becomes an immutable past card containing only its title, final message, task
ID, and turn ID. Channel names mirror task names with `🟢` for a running turn
and `⚫` for a stopped task.

Completed turns also produce a notification in `codex-completions`. The
notification mentions the configured Discord user and links directly to the
completion post in the corresponding task channel. Notifications lead with the
completion mention, put a one-line summary second, and use a bare Discord URL
as the final line for channel-aware compact display.
Completion post and notification message IDs are tracked separately so
reconnect recovery can resend a missing notification without duplicating the
task result.

Transient communication failures are recoverable across the Discord gateway,
Discord REST, Codex app-server WebSocket, attachment fetches, DNS, TCP, and
TLS. Initial login/setup retries use exponential backoff capped at five
minutes, and a network timeout reaching the process error boundary is logged
without terminating the Bridge. Authentication, certificate, configuration,
and programming errors remain fatal.

No Discord project registration or catch-up command is required. The bridge
paginates through active and archived task lists, reconciles categories every
30 seconds and after reconnect, and reacts to task start, archive, unarchive,
rename, and delete notifications. `/codex sync` forces an immediate pass.
