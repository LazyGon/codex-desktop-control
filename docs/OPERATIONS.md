# Operations

## Start the shared Desktop

1. Quit any normally started Codex Desktop.
2. Start **Codex Shared Server** from the Start menu or taskbar.
3. The launcher either starts the shared app-server or validates and reuses the
   healthy app-server already owned by this checkout. It reconciles managed
   project paths and task assignments while Desktop is still stopped, and then
   starts Desktop.
4. Wait for two ascending tones. They mean the Desktop connection to the
   shared app-server was verified.
5. Two descending tones on exit mean an app-server owned by that launcher
   session and its transient environment were cleaned up. A Desktop-only attach
   does not take over or clean up the existing server.

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

To create a Codex task from a phone, create a text channel inside the target
project category and send its first ordinary message. The Bridge uses the
category's stored project path for `thread/start`, derives the task name from
the channel name, binds the existing channel, and delivers that message as the
first turn. Rapid messages in the same channel are serialized, so only one task
is created. Unbound channels in the control, archive, or unrelated categories
are ignored rather than becoming tasks.

Use the pinned panel in `codex-remote` for connection status, account usage,
read-only Codex resource inventory, full sync, pending requests, and task
navigation. Every task channel has its own pinned panel for delivery mode,
watch level, detailed status, pending requests, the task control center,
archive/restore, and confirmed interrupt. The control center uses app-server
catalogs for model, reasoning, permissions, and Plan/Default mode. Its More
menu exposes Fast/service tier, personality, memory, goal, compact, fork,
review, and background terminals. Rename a task channel to rename the
Codex task. The next sync normalizes the channel name and restores its status
emoji prefix.

Assistant-card `Linked files` pickers provide individual downloads and a
`Download all as ZIP` action. The ZIP contains only links that pass the normal
project-boundary, secret-file, and filesystem-link checks. Unavailable entries
remain excluded and visible as locked items.

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

No Discord project registration or catch-up command is required. The bridge
paginates through active and archived task lists, reconciles categories every
30 seconds and after reconnect, and reacts to task start, archive, unarchive,
rename, and delete notifications. `/codex sync` forces an immediate pass.
