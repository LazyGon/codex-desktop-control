# Operations Runbook

## Normal startup

The `Codex Discord Remote` Scheduled Task starts at user logon. If the shared
app-server is absent, the bridge starts
`launcher\CodexSharedLauncher.exe` and retries with exponential backoff. The
launcher remains the owner of the Desktop/app-server lifecycle.

Use the Start menu folder **Codex Remote** for manual start, status, or graceful
stop. The bridge prevents duplicate instances with `data\bridge.lock`.

## Phone workflow

1. Run `/codex status` in `codex-remote`.
2. Open the project category and select the automatically synchronized task
   channel. To create a task, create a text channel in that project category
   and send its first ordinary message. The channel name becomes the task name,
   and the category selects the working directory. Archived tasks are under
   `Codex Archived`.
3. Review orange user cards, final assistant cards, and commentary cards captured
   while the task was live. `🟢` in the channel name means a turn is running;
   `⚫` means stopped. Pinned control panels are purple, while completed result
   cards are blue.
4. Use the pinned task panel's delivery-mode select, or post an ordinary
   message for automatic delivery. Slash commands remain available for explicit
   task IDs, search, and attachments.
   With `plainMessageInputEnabled`, an ordinary message in the task channel is
   equivalent to `deliver`. After app-server accepts it, the original message is
   replaced with an orange user card; `❌` includes an error reply. One image,
   or one text file up to 200 KB, can be attached to an ordinary message.
5. Watch the latest turn card. It shows current commentary, reasoning, and work
   state. When the next commentary starts, the previous post becomes a compact
   past card. Turn completion leaves a final card with task and turn identity,
   then reposts the pinned task control panel directly below it.
6. Respond to approval or input cards when they appear.
7. Use `Project files` in the pinned task panel to browse the task working
   directory. Select a directory to open it or a file to post it into the
   private task channel. `/codex-files` opens the same browser with explicit
   task autocomplete. On an assistant card, use `Linked files` to select a
   local file that Codex linked in its message. To retrieve the entire working
   directory, tap `📦 Download project`, review the secret-exposure warning,
   and confirm `Archiveを作成`.

The `Linked files` picker also provides `Download all as ZIP`. It archives all
currently permitted links, preserves each project-relative path, skips entries
shown as locked, and posts a SHA-256 manifest with the ZIP or numbered ZIP
volumes.

Files that fit in one attachment are posted directly. Larger files are posted
as numbered 7z volumes followed by a `.7z-manifest.json` file. Download every
volume into the same folder and open the `.7z.001` file with a 7z-compatible
phone or desktop app. The manifest records the original-file and per-volume
SHA-256 hashes.
Entries marked `🔒` remain indexed but cannot be downloaded because they are
secret/protected, outside the project boundary, or a filesystem link.
The whole-project archive is an explicit exception: it includes `.git`,
`.env`, keys, credentials, and other protected regular files. It skips
symlinks, junctions, and special filesystem entries. Download every
`.project.7z.*` volume into one folder and open `.project.7z.001`. A
single-volume transfer is opened as `.project.7z`. Extraction creates the outer
project directory. Both source and archive must fit under the configured
transfer maximum.
The project browser itself never leaves the task working directory. A file
explicitly linked by Codex may also resolve in a sibling repository under a
parent shared by managed projects, which covers cross-repository work without
opening arbitrary-path input.

The pinned `codex-remote` panel provides status, account usage, read-only MCP/
Skills/Plugins/Hooks/experimental-feature inventory, full sync, pending
requests, and task navigation. Each pinned task panel provides delivery mode,
watch level, detailed status, task-scoped pending requests, a task control
center, archive/restore, and confirmed interrupt. The control center uses
dropdowns populated from the shared app-server for model, reasoning effort,
named permission profile, and Plan/Default mode. Its More menu includes Fast/
service tier, personality, memory, goal, context compact, fork, review, and
background terminals. Renaming the channel renames the Codex task. Moving it between its
project and archive categories remains the direct channel-level archive UI.

Permission changes, context compact, fork, goal removal, and background
terminal termination always require confirmation. A terminal can be terminated
only when it is listed by the selected task's app-server background-terminal
inventory. Discord does not expose arbitrary shell execution, raw PID kill,
task deletion, filesystem writes or deletion, global configuration mutation,
or the deprecated rollback API. The only filesystem surface is bounded read-only file
browsing and download; it does not expose arbitrary paths, writes, or deletion.

All projects and top-level tasks are automatic. The bridge scans active and
archived task lists every 30 seconds, after reconnect, and after task lifecycle
notifications. `/codex sync` forces the same reconciliation immediately.
Moving a task channel into `Codex Archived` archives the matching Codex task.
Moving an archived channel back to its own project category unarchives it.
Moving it to any unrelated category is rejected and immediately rolled back to
its recorded category without changing the Codex task state.

An unbound channel becomes a task only when it is inside a managed project
category. The first valid post creates and binds one task before delivery;
follow-up posts in that channel are processed in order. Control, archive, and
unrelated categories do not create tasks from ordinary messages.

When a turn completes, `codex-completions` starts by mentioning the configured
user with `タスクが完了しました。`, puts a one-line final-answer summary on the
second line, and uses the bare completion-message URL as the final line so
Discord renders its channel-aware compact form.

`normal` is the default watch level. `quiet` keeps only completions, errors,
and requests. `verbose` adds all item and token details to the live view.

## Connection recovery

The Discord gateway and Codex app-server both reconnect automatically. When
app-server reconnects, every non-archived task is resumed on the same server and read
from persisted history. Historical reconciliation backfills user cards and final
assistant cards only. Commentary is captured while the turn is actively subscribed;
already-persisted commentary cards are preserved by task, turn, and item identity.
A completed turn not matching
the binding's last known turn ID is posted as a missed completion before normal
streaming resumes. Final and notification message IDs are persisted separately,
and visible identity markers are checked during recovery, so interruption
between Discord delivery and local state persistence does not duplicate a turn.

Use `Get-DiscordBridgeStatus.ps1` when the bot appears offline. Relevant files:

- `data\runtime.json`: process, Discord, and app-server status.
- `data\state.json`: project/category, task/channel, and turn/message identity
  bindings plus completion-notice IDs.
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
