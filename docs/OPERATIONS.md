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
   The launcher reads the current size from an open Desktop log handle; the
   directory listing can lag behind handshake records already in the file.
5. Two descending tones on exit mean an app-server owned by that launcher
   session and its transient environment were cleaned up. A Desktop-only attach
   does not take over or clean up the existing server.

When the Store updates `OpenAI.Codex` during a shared session, the launcher
recognizes the replacement package and pauses every goal whose current status
is `active`. It keeps the old shared app-server alive until all active turns
have drained, then replaces the Desktop and app-server together. After the new
shared connection is verified, it resumes only the goals that this update
paused. Goals already paused, blocked, limited, or complete are not changed.
The completed drain receipt from a prior package pair does not block a later
update; an incomplete receipt for a different pair still stops recovery for
inspection instead of being overwritten.
After a Windows logon, the Discord Remote host starts the shared launcher before
the full Bridge cold start when `autoStartSharedDesktop` is enabled. Manual
launch is not required after an app update or reboot.

The most recent reconciliation result is stored in
`launcher\state\project-sync-last.json`. Backups of the Desktop global state
are stored in `launcher\state\project-sync-backups\` with exclusive names that
remain collision-free if launch attempts overlap. A reconciliation failure stops
startup before Desktop opens, so the existing Desktop state is not silently
replaced or partially updated. On a first installation, reconciliation is
skipped until both Desktop and Bridge have created their initial state files.
After writing its result, the project-sync CLI flushes output and exits; a
lingering App Server WebSocket close handshake must not hold Desktop activation.

Launcher self-tests use a port-specific runtime-state file and never replace
the live `launcher\state\current.json`.

On each normal launch, the launcher verifies a managed root-level
`mcp_servers.codex_app` stdio definition in `~/.codex/config.toml` before it
decides whether to start or reuse the shared App Server. It also passes that
complete definition directly to every new shared App Server. Therefore this
repair is applied at logon, manual launch, runtime reuse, and Store-update
recovery without a second server or a Desktop-private server. The definition's
stable bridge resolves the installed Desktop package and native app-tools pipe
at MCP startup; it does not store a package-version-specific path in the user
config or open another listener.

The launcher preserves the small bundled Desktop app-tools plugin alongside
the corresponding cached App Server. If Store servicing removes the plugin
while that Desktop is still running, the tool bridge verifies and uses the
copy paired to that exact package and server hash.

If Desktop reports `invalid transport in mcp_servers.codex_app`, do not add a
`transport` key. Run the shared launcher once. It atomically adds or refreshes
its marked `mcp_servers.codex_app` command definition and keeps the old config
as a timestamped backup. If an unmarked `codex_app` definition already exists,
the launcher preserves it and stops with a conflict instead of guessing which
definition owns the key. `codex mcp list` should then show `codex_app` with
`launcher\codex-app-tools-bridge.mjs` as its argument.

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

## Update Desktop and its shared AppServer

Use [OpenAI's Desktop update mechanism](https://learn.chatgpt.com/docs/enterprise/manage-app-updates)
or the [signed MSIX](https://learn.chatgpt.com/docs/enterprise/windows-deployment).
For a manual MSIX update, Windows supports
[`Add-AppxPackage -DeferRegistrationWhenPackagesAreInUse`](https://learn.microsoft.com/en-us/powershell/module/appx/add-appxpackage#-deferregistrationwhenpackagesareinuse).
An accepted deployment may still be pending until the next Windows app launch.
Check the registered version with `Get-AppxPackage OpenAI.Codex`; do not reinstall
merely because the process still reports the previous version.

1. Allow the app to finish its update. Quit Desktop normally if it has already
   reopened on the new package. The handoff waits while any ChatGPT process
   remains in the current session.
2. Once a newer package is registered, the running shared supervisor verifies
   the same package family and prepares its versioned cache. It arms a
   current-user, no-trigger Scheduled Task and then sends one graceful shutdown
   request to its isolated AppServer console. AppServer stops admitting new work
   and waits for already running work. The launcher does not enumerate histories,
   pause goals, or force the shutdown. The Bridge stays running.
3. The scheduled worker verifies the old processes exited and the clean exit was
   recorded. It starts the registered replacement once, or adopts a replacement
   already started through the shared launcher. It verifies the actual Desktop
   loopback connection, AppServer health and bundle hash, and, if Bridge was
   running, its Gateway readiness and connection to the replacement.

Each operation keeps `request.json`, `drain.json`, `result.json` and, if it
started the replacement, `startup.json` under
`launcher/state/runtime-handoffs/<id>/`. A `verified` result is complete.
`desktop-ready` means only the Bridge reconnection remains to be verified.
If the scheduled worker was interrupted, run the **same** scheduled task
(`Codex Shared Runtime Handoff <id>`) after inspecting its receipt. The worker
reads actual state before acting and does not repeat a recorded launch request.
If no replacement is running after a failed or uncertain launch, use the
normal shared launcher once after verifying both old processes exited and no
replacement is already starting. Keep the original receipt. If the new Desktop
opened outside the shared launcher, quit it normally before opening the shared
launcher. If the signal could not be sent to an isolated AppServer console,
the old server stays alive; do not send a second interrupt to it.

For an explicitly requested update from a Codex task, use
`launcher/Refresh-CodexSharedRuntime.ps1` with the exact `-WaitForThreadId`,
`-WaitForTurnId`, `-FromVersion` and `-ToVersion`. To install an official MSIX
that has not registered yet, also pass its `-PackagePath` and `-PackageSha256`.
The scheduled controller verifies the signature and package identity, waits
for the exact turn and for loaded work to go idle, and requests a normal
Desktop shutdown once. The supervisor drains AppServer, then the controller
installs only if needed and uses the same replacement worker. Completion is
delivered once to the requesting task. If the task is unloaded, the
controller uses Desktop navigation and requires
a successful local resume for that exact task before sending the completion.
It does not load the task directly if Desktop navigation cannot be verified.
If the tool catalog is still starting, the controller releases the unused
MCP context before checking with a fresh one. If Desktop loads the task
while the controller waits, a fresh Desktop resume can confirm it directly.
An uncertain navigation or completion delivery is never replayed.
The refresh receipt is `launcher/state/runtime-refresh-last.json`; Desktop
load evidence is in the request's `completion-desktop/` directory. If Windows
defers registration,
inspect the actual registered version before any other install attempt.
Optional observation limits default to zero (no deadline).

For an explicitly authorized normal restart without a package update, use the
same controller with `-RestartOnly` and identical `-FromVersion` and
`-ToVersion`. Omit package inputs and forced shutdown. This reuses the same
clean-exit and one-shot same-task continuation checks, without installing an MSIX.
If Desktop is opened separately while the old runtime is still releasing, the
controller stops and records the conflict without closing the reopened Desktop.
If explicitly approved for that same-version restart, `-CleanupExitedDesktopHelpers`
can terminate only identity-verified residual Electron children captured before
normal shutdown. It requires proof that the captured root exited, journals each
termination attempt, and refuses unrelated or unverified processes. It does not
force the Desktop root, AppServer, Bridge, or Windows to close.

The shared launcher enables Chrome Computer Use compatibility for Desktop
startup without a package-version allowlist. The explicit loopback WebSocket
still selects the shared AppServer. Only the launched Desktop receives the flag
that lets it add its own signed browser access context to the normal Computer
Use configuration. The launcher does not read or store that context. The
runtime state records the setting in `desktopBrowserAccessCompatibility`.
No user-level environment or scheduler setting is required.

The optional `-DesktopBrowserAccessTrial` remains accepted for recorded
same-version restart requests; normal startup needs no trial option. Previous
version restrictions were an inspection aid, not a browser authentication or
transport contract, and have been removed. Package identity, signed access
verification, and the loopback transport remain enforced by their existing
owners. After an app update, verify the real Chrome route with integrated
`cua_repl`; a ready MCP server alone does not prove browser access. A task first
loaded by a headless client may still lack Desktop's signed context.

On that verified shared Desktop runtime, the Discord Bridge checks the
existing task before loading it to send input. An already loaded task needs
no navigation. For `notLoaded`, the Bridge calls the Desktop's
`codex_app.navigate_to_codex_page` through the shared App Server's
`mcpServer/tool/call` API. This may switch the visible Desktop view. The
Bridge uses its own in-memory MCP context without starting a turn, since a
cold task cannot host the tool call itself. If the tool catalog cannot be
loaded, the Bridge releases that temporary context and can prepare a fresh
one on the next normal sync. This cannot repeat a navigation already sent.
It waits
for a fresh, successful `thread/resume` receipt for that exact task from the
live Desktop process and for the shared server to report the task loaded.
Only then does the Bridge subscribe and send. Other tasks can keep receiving
messages. If the receipt is missing, the ordinary Discord message stays in
the existing delivery queue; immediate controls return without dispatch.

The separate recovery path detects the exact built-in Computer Use host
error from the latest finished turn. It releases the Bridge's own idle
subscription if present, then checks whether the task unloaded. The owner
chose to wait for a single-digit number of seconds if that is the configured
grace. The verified App Server defaults to 60 seconds; with that grace, the
Bridge does not wait a minute. If the task is still idle and loaded, recovery
can archive it temporarily, verify `notLoaded`, restore the same task and
history, and hand it to the same Desktop loading path. Before archiving, it
checks for goals, pending input or approval, background terminals, and
descendant or attached tasks, including archived ones. Any of these blocks
automatic archiving. An unanswered asynchronous question stays attached to
the same task and remains answerable; an active or unconfirmed question
post or answer blocks archiving. Discord synchronization waits through the
round trip.

Receipts are in `discord-bridge/data/desktop-first/` and
`discord-bridge/data/browser-initialization/`. Archive, restore, and Desktop
navigation each have their own claim. An interrupted or uncertain mutation is
not automatically repeated or reversed. If a direct read proves the same
task and history are already restored and unloaded, the Bridge can continue
with the Desktop handoff alone. Verify the actual task state from the shared
App Server before any manual recovery. After a confirmed load, a
later cold load may request navigation again. A Desktop load receipt proves the loading
order; a successful Computer Use call proves browser access. The Bridge does
not replay the failed turn.

If normal shutdown still leaves Windows reporting `0x80073D02`, an Owner may
explicitly approve `-AllowTargetApplicationShutdown` for one manual update.
This uses `ForceTargetApplicationShutdown` only for the verified Codex package,
not its dependencies or Windows. Without this option, installation retains
deferred registration. For a legacy running supervisor, the same explicit
approval permits migration only after the source turn and loaded work are idle
and the existing supervisor has released its own server. Actual exit codes and
the legacy approval are recorded in both handoff receipts; automatic handoffs
still require a clean exit. This does not authorize a Windows restart.

The new handoff loads on the next normal shared startup. An older running
supervisor is preserved unless the explicit manual migration above is approved;
ordinary updates require the new graceful-shutdown capability. Historical `package-update-drain.json`
records are retained and are never applied by the new launcher.

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
Discord message is replaced with the same user-card format. Ordinary Discord
messages received after the outbox-enabled Bridge starts are persisted under
`discord-bridge\data\delivery-outbox` before mutation. Older Discord history is
excluded by a one-time persisted cutover. Later reconnects and Bridge restarts
scan visible task channels after their per-channel cursor and recover missed
post-cutover messages. Pre-mutation `queued` entries resume after subscription restore;
post-mutation uncertainty is reconciled by exact request ID and otherwise stops
without automatic resend. Delivery and reaction callback receipts are atomic
and exact-attempt-bound. On reconnect, the bridge checks bounded turn metadata
for every visible task, then resumes only active tasks or tasks with a missed
completion before outbox and task-list work. Unchanged idle tasks remain lazy
and the existing task-sync poll detects later activity before reconciliation.
Task inventories are fetched serially. Subagent discovery uses paginated
canonical database-only metadata for active and archived children, following
parent links from mirrored tasks without reading parent turn bodies. Existing
child bindings are retained even when absent from the current metadata list;
completed and unloaded children are not periodically hydrated. The bridge then
reconciles task history against both persisted
message IDs and visible identity fields. Long user and final-answer text
remains one card, with the full text attached when necessary.

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
minutes, and an isolated network timeout reaching the process error boundary is
logged without terminating the Bridge. An unresolved transient Gateway
handshake failure marks Discord unready and, only after five uninterrupted
minutes, a dedicated deadline timer gracefully recycles the Bridge through the
Scheduled Task. Healthy
Gateway sessions are not periodically reconnected. Authentication, certificate,
configuration, and programming errors remain fatal.

No Discord project registration or catch-up command is required. The bridge
paginates through active and archived task lists, reconciles categories every
30 seconds and after reconnect, and reacts to task start, archive, unarchive,
rename, and delete notifications. `/codex sync` forces an immediate pass.


<a id="task-and-goal-operations"></a>

## Task and goal operations

## 共有AppServerでのゴール操作（2026-10-19 ユーザー指定）

- ゴールの設定・変更・再開・読取りは、そのPCの正準な共有AppServerで行う。組み込みの `create_goal` が「未完了のゴールあり」と拒否しても、利用者へ手動クリアを求める前に、共有AppServerの `thread/goal/set` を確認する。置換のために旧ゴールを達成したふりで `complete` にしない。SQLiteやrolloutを直接書き換えず、別AppServerも起動しない。
- 接続先はcontrol utilityの `launcher/state/current.json` から取得する。既存の `control/codex-shared.mjs` の `validateSharedRuntime` と `control/shared-task-operations.mjs` の `connectCanonical` を使い、実行中の正準runtime・loopback・Desktop接続を確認する。既存clientが `initialize` と `initialized`、必要な `experimentalApi` を扱う。Node REPLが依存先の `node:process` importを拒否する場合は、通常のNode CLIから同じ既存moduleを使う。
- 操作前に正確な `threadId` を明示し、`thread/read`、`thread/turns/list`、`thread/goal/get` で対象・workspace・最新turn/status・旧ゴールを再読する。必要な場合だけ `thread/resume` し、model/effort/approval/sandbox/cwdの上書きを渡さない。ゴール設定だけのために稼働中turnへ重複した `turn/start` を送らない。
- 読取りは `client.call('thread/goal/get', { threadId })`。利用者が新しい目標と作業継続を求めた時は `client.call('thread/goal/set', { threadId, objective, status: 'active' })` で設定・置換する。目標は空でない4,000文字以内。既存の未完了・pausedゴールも、明示された変更/再開の範囲で直接更新でき、先にclearする必要はない。
- 同じ目標の再開は `client.call('thread/goal/set', { threadId, status: 'active' })` とし、`objective` を省略する。pause・clear・budget変更も利用者の明示指示がある時だけ行う。解除は `thread/goal/clear` であり、通常の更新の前処理にしない。token予算は依頼されていなければ指定しない。blocked/completeの判断条件や上位の制限は維持する。
- 置換前のgoal本文・status・使用量・budgetと操作対象turnをignored作業領域へ控える。新objectiveに伴う使用量の扱いは実行版の応答で確認し、保持・resetを推測しない。設定応答と別の `thread/goal/get` でobjective/status/対象IDを照合してから成功と報告する。結果不明のmutationは盲目的に再送せず、先にreadbackする。
- 既存の共有clientを再利用し、操作のためだけの常駐サービス・watcher・独自AppServerを作らない。資格情報・会話本文をコマンドラインへ載せず、必要なgoal payloadは作業領域のファイルから読む。接続不可やAPI非対応なら、未設定の事実と具体的な阻害を報告する。

公式のAPI説明: https://learn.chatgpt.com/docs/app-server （Manage a thread goal）。版固有の挙動は正準runtimeでの応答を優先して確認する。

## Task creation and ChatGPT delivery boundary

- When the user requests a separate local Codex task, create it directly on the
  existing shared App Server with `thread/start`. Do not use Desktop/high-level
  `create_thread`, including when a project or projectless target is available.
- Preserve the requested workspace and existing approval/sandbox defaults. Read
  the returned exact ID with `thread/read`, verify membership in the paginated
  ordinary `thread/list`, then verify its Discord binding. A creation receipt,
  list membership, turn acceptance, and Discord binding are separate facts.
- Do not recreate a task when list/binding verification fails. Retain the exact
  ID and report the missing fact. Do not resume an interrupted predecessor.
- For task delivery, read its current turn immediately before exactly one
  `turn/steer` with `expectedTurnId` or `turn/start`. Require the accepted exact
  turn identity; an uncertain mutation must not be retried on another surface.
- Official ChatGPT `send_message_to_thread` returning only `threadId` does not
  establish delivery, persisted message identity, completion, or a callback.
  Do not use it as the Reviewer Accessor transport for governed reviews or
  attachment/Receiver handoffs. Preserve uncertain attempts without replay.
- See `docs/official-conversation-api-investigation-20261005.md` for the tested
  ownership boundary, upstream evidence, and supported operating routes.

### 過負荷時の担当維持と所有記録（2026-10-12 PO訂正）

- サーバー過負荷・capacityエラーを理由に、親へ担当作業を引き取らない。元の担当threadと保存済み進捗を維持し、正準最新状態で終了した失敗を確認したら同じ担当を再開する。失敗回数を所有変更や放棄の条件にしない。
- ユーザーが既に再開した担当は、現在のturnを読み、稼働中なら重複startしない。正常完成した依頼は再実行させない。送信結果UNKNOWNは再送せず、意図的な停止・paused・設計完成待ちの実装は、この過負荷復旧で再開しない。
- 各担当を正確なthread ID、表示名、現在の担当範囲、最新成果、次の作業で記録する。親の統合・確認と、担当の成果作成を区別する。所有を変える必要がある場合は、変更前後のowner、引取範囲、親が実施済みの作業、未完、元担当の再開可否を一つの記録と担当threadへの通知で明示する。
- 以前の親引取記録は消さず、撤回・元担当復帰の前向き記録を結合する。親が既に行った限定訂正は入力成果として渡し、同じ調査・編集を二重に行わせない。再開にも共有AppServerと既存の排他配送journalを使い、新watch/heartbeat/ACK往復を増やさない。

<a id="restart-and-signin"></a>

## Restart and sign-in

## 再起動後の自動サインイン（2026-11-22 利用者訂正）

利用者の依頼Uにより、lazyg（当該SID）のWindows標準ARSOを恒久的に有効（OptOut=0）にする。従来の「通常起動・手動再起動では有効にしない」「個別再起動時だけ一時的に0へ変え1へ復元する」という指定を上書きする。サインイン後の画面ロックを維持する。エージェントはパスワードを取得・保存せず、UACやBitLocker等の保護要件を緩めない。

- 管理者変更は既存Codex Admin Terminalを使う。保留中leaseがないことを確認して、従来のCodex Restart Sign-In Restoreタスクを無効化する。過去の操作記録や保護された原本は書き換えない。従来の一回限りARSO実行経路をそのまま再使用しない。
- ARSOはWindowsが準備する再起動・更新が対象で、停電・クラッシュ後の起動を保証しない。実効ポリシー・暗号化等の前提と実際の再起動での成立は分けて報告する。Windows再起動自体は引き続き個別許可が必要。
- 停電後も含む自動ログインはSysinternals Autologonを提案するだけにし、本人がパスワードを入力する方式以外を実施しない。
- lazygのAtLogOnにClaude対話セッションと雑談HaikuをLimited/Interactive・最小化で起動する。既存同セッションは重複起動せず、遅延と有限の再試行を使う。依頼Uの登録時は新規起動しない。

公式仕様: https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/winlogon-automatic-restart-sign-on--arso-


### Codex Desktopと共有AppServerの正常再起動

この手順は履歴移行とは独立した、Codex Desktop／共有AppServerの正常停止・再起動・元タスク復帰の共通手順である。Windows自体の再起動、更新、別アカウントへのログインは含まない。利用者から許可された停止・再開範囲だけを扱う。

1. **停止前の状態を正準APIで保存する。** 正準の launcher/state/current.json と既存 validateSharedRuntime／connectCanonical を使う。所有チャットと対象ごとに thread/read・thread/turns/list・thread/goal/get を読み、正確なID、稼働turn、モデル・推論強度、workspace・権限、goal本文・status・予算・使用量、利用者の許可参照を保存する。稼働中だったタスクだけを復帰対象とし、元からidle・意図的停止・設計待ち・HOLDのタスクを起動しない。native子は元親の所有経路を維持する。
2. **自分を終了させる前に、独立した復帰処理を実際に稼働確認する。** 共有AppServerのjob外にある、同じWindowsユーザー・SID・Sessionの一回実行workerを使う。既存のLimited／Interactiveスケジューラ経路を優先し、常駐サービスや別AppServerは作らない。workerのPID・開始時刻・所有元、永続記録、同じチャットへのcompletion callback、停止方法を確認する。登録receiptや「armed」ファイルだけで生存・配送を証明したことにしない。待機を特定turnやユーザー発言数で失効させず、後の停止・取消を優先する。
3. **goalとturnを分けて一時中断する。** 稼働turnのあるactive goalだけ、元本文・予算・使用量を保って一時pausedにし、readbackする。元からblocked／pausedのgoalをactiveへ変更しない。最新turnを直前に再読して、その正確なturnIdへ turn/interrupt を一回だけ送る。typed terminal状態を確認し、自然完了した仕事を再実行しない。中断済みの失敗から続行する際は保存済み記録と現在状態を照合し、同じturnを再中断しない。
4. **既存の正常終了経路を使う。** launcher/CodexDesktopShutdown.ps1、CodexRuntimeHandoff.ps1等を再利用し、正準Desktop・共有AppServer・supervisorのPID／開始時刻を固定する。Desktopを正常終了させ、既存supervisorが共有AppServerへ送る正常終了と競合して二重にsignalを送らない。強制終了を正常終了のfallbackにせず、停止拒否や結果不明は実状態を調べる。Desktop・server・supervisorの終了を確認してから、DBを扱う別工程へ進む。
5. **子プロセスの終了判定を曖昧にしない。** WindowsのNode処理は共通 launcher/CodexNodePhase.ps1 を使い、実Processの終了コードとUTF-8のstdout／stderrを記録する。Start-Processの返却objectをRefreshした後のnull ExitCode等を、成功にも失敗にも決めつけない。実行wrapperの変更時は、独立した入力でexit 0の成功、非zeroの拒否、日本語出力の保持を確認する。処理済みのstdout・journalを調べず、失敗表示だけを根拠に工程を再送しない。
6. **正準ランチャーを一回だけ起動し、実接続を確認する。** 既存 Start-CodexShared.ps1 等を使い、current.json、loopbackのlistener、実serverとDesktopの接続を既存検証utilityで確認する。起動要求を永続化してから実行し、UNKNOWNなら新しく起動せずreadbackする。接続先・model・approval・sandboxを推測で置換しない。server-readyやDesktop接続成功は、元タスクの復帰成功とは別である。
7. **元のDesktop ownerでタスクを復帰する。** loadedなタスクへ再ロードや新しいloaded-event待ちを一律に要求しない。notLoadedだけ、既存のnative Desktop表示／公式再開経路で元タスクを読み込む。共有クライアントの勝手なresumeでモデル実行のownerを奪わず、別AppServerへfallbackしない。自分が一時pausedにした同じgoalだけ、本文・予算・使用量を置換せずactiveへ戻してreadbackする。goal復帰が自動turnを開始する場合があるため、最新状態を確認して重複startしない。既存turnへexpectedTurnId付きsteer、idleなら同じthreadへ一回のstartとし、モデル・workspace・権限等のoverrideを送らない。元の停止/HOLD、実行済み操作、UNKNOWNの再送禁止を引き継ぐ。
8. **復帰を実読してから完了にする。** 各対象のacceptedな正確なturn IDと、その後のinProgressまたは正常完了を正準APIで確認する。IDだけの送信receiptや再起動workerのexit 0では、配送・稼働を証明しない。中断成功／正常終了／新runtime接続／各タスク復帰／所有チャットへの完了通知を別に記録する。元タスクを止めた後に途中失敗した場合は、その段階と実状態を報告し、未実行と確認できる復帰を優先する。accepted・dispatching・UNKNOWNを無条件に再送しない。完了した一回実行workerは登録を解除する。

履歴移行・更新・その他のオフライン保守は、上記とは別の入力・結果・検証を持つ任意工程とする。その失敗を理由に、正準runtimeの再起動と元タスクの復帰を止めない。共通再起動手順へ特定案件のタスクID・作業内容・移行SQLを埋め込まず、実行ごとの状態は既存ignored作業領域へ保存する。



### 保護依存の保守

Restart preparation binds the exact ordinary Desktop owner and its real
workspace; it does not require the control utility to own Product work. A loaded
task is read without `thread/resume`; postboot loading uses the existing native
Desktop completion route. Restore only the recorded maintenance pause, matching
objective, budget, creation and pause timestamps, and preserving usage. A later
user stop/change or an uncertain mutation prevents automatic restoration.
`Refresh-RestartDependencies.ps1` may refresh reviewed dependency pins through
the common admin host only while the sign-in lease is idle and all historical
restart operations are terminal. It preserves those operations, protected
executable assets, the previous config and its ACL. Do not use the historical
unused-install updater against a completed installation.

<a id="windows-execution-environment"></a>

## Windows execution environment

## Windows command overhead (2026-10-12)

- Prefer a persistent Node REPL for eligible local file and API operations, and
  batch independent reads. Each shell tool call can create a separate PowerShell
  process; high concurrency adds startup and resource costs.
- The installed 0.162.0-alpha.17.2 shell selector resolves PowerShell to the
  WindowsApps `pwsh.exe` alias even when a full PowerShell path is supplied.
  That alias failed with access denied in PTY mode on this PC. For a required
  PowerShell PTY, select `shell: "cmd"` and invoke the existing unpackaged
  PowerShell executable with `-NoProfile -File` and an audited script. The
  bundled runtime is under `.cache/codex-runtimes/codex-primary-runtime/` in
  the current user's profile; verify it exists before use.
- For Node CLI operations, invoke Node directly where available. A command
  shell wrapper is a fallback, not evidence that all command latency is fixed.
  Keep cwd and argv explicit and preserve the owning task's permissions.
- PTY output includes terminal control sequences. Keep canonical JSON/evidence
  in files or use non-terminal API/Node output; do not hash PTY display bytes.
- A Node REPL child environment may omit ComSpec and expose only `.CPL` in
  PATHEXT. Before launching a persistent Windows service, validate these two
  values and inherit the saved Windows values for that child if necessary.
  This is a child-process repair, not a registry or security-policy change.
- Recent control reads use `recent-thread-messages.mjs`; do not fetch an entire
  rollout just to tail a few messages. Session completion caching consumes
  append bytes; machine state snapshots use compact atomic JSON.
- Evidence and limitations: ../その他/codex-performance-20261012/report-current.json
  records the installed Unicode guard fix and user-authorized exact executable
  Defender exclusions. Effective exclusion checks and eight concurrent commands
  verified the observed scanning bottleneck improved without a shared restart.
  The exact inducing API and future-version paths remain explicit limitations.
- The runtime initializer now prefers a signature-verified bundled PowerShell
  for future child launches. This changes only the launcher process PATH and
  takes effect at the next normal or individually authorized shared startup;
  do not treat the running server as updated. See launcher-powershell-fix.json
  in the same evidence directory.

<a id="omen-ssh"></a>

## OMEN SSH

## OMENとのTailscale SSH（2026-11-18）

- このPCはSurfaceBook2（利用者 `lazyg`、Tailscale `100.75.107.79`）。OMENはLAPTOP-728OIQQK（利用者 `yosih`、`100.104.140.74`）。接続前にTailscaleの実接続先を確認する。
- SurfaceからOMENへは `ssh omen` を使う。専用の秘密鍵は `C:/Users/lazyg/.ssh/id_ed25519_omen_vocalverse`、接続定義は同じディレクトリの `config`。秘密鍵を他PCへコピーせず、`BatchMode=yes`・`StrictHostKeyChecking=yes` を維持する。ホスト鍵が変わった場合は検証済みの別経路で変更理由と指紋を確認し、警告を無効化しない。
- 検証済みEd25519ホスト鍵指紋はOMEN `SHA256:EcqMwNJ63ZVJgO357JsQoFy+pmEdlj8adGJFe8dC7Mw`、Surface `SHA256:5YD6V0qiZE89yOjz303F64Kix5vVd1Ydkc6+WpKX+E0`。
- SurfaceのsshdはIPv4の `0.0.0.0:22` で自動起動し、Tailscale仮想IPの付与前でも起動できるようにする。Windows Firewallは既存のTailscale経路（ローカル `100.75.107.79`・リモート `100.104.140.74`）と、ローカル・リモート双方 `192.168.40.0/24` の宅内LAN経路だけを許可する。パスワード・対話認証と転送は無効、認証方法は公開鍵のみ。既存鍵を置換せず、ホスト秘密鍵と管理者用authorized_keysはAdministrators所有・SYSTEMとAdministratorsだけがアクセスする。
- SSHログイン後にCodexタスクを扱う場合は、そのPC自身の正準共有AppServerへ接続する。OMENのcontrol rootは `C:/git/other/codex-desktop-control`、Surfaceは `C:/Users/lazyg/Documents/ChatGPT/codex desktop control`。各rootの `launcher/state/current.json` と既存 `control/codex-shared.mjs` の `validateSharedRuntime`、`control/shared-task-operations.mjs` の `connectCanonical` を使う。loopback listenerを外部へ公開せず、別AppServerを起動しない。
- 操作対象の正確なthread ID・現在turn/statusを再読し、稼働中はそのturnへsteer、idleは同じthreadへ一度だけstartする。model・workspace・権限を上書きしない。利用者が許可したタスクへの連絡だけを行い、UNKNOWNは再送しない。SSH利用は他タスクのIDや管理者権限を借りる許可ではない。管理者処理は対象PCの既存Codex Admin Terminalを、そのPC上の所有タスクから使う。


### OMENからの宅内LAN経路（2026-11-22）

- OMENの `ssh surface-lan` は `SurfaceBook2.local` をIPv4で解決し、Surface利用者 `lazyg` へ既存鍵で接続する。短い名前 `SurfaceBook2` はTailscaleへ解決されるため、LAN用へ代用しない。`.local` は宅内mDNSに依存し、解決できない場合はSurfaceの現在の `192.168.40.x` を確認する。固定IPやルーター設定を勝手に追加しない。
- OMENの既存鍵 `C:/Users/yosih/.ssh/id_ed25519_surface_codex_20261118` と既存 `known_hosts_surface_codex_20261118` を使う。`BatchMode=yes`・`IdentitiesOnly=yes`・`StrictHostKeyChecking=yes`・`HostKeyAlias=100.75.107.79`・`ForwardAgent=no`・`ClearAllForwardings=yes` を維持する。Surface側の登録鍵指紋は `SHA256:L1KVh9yzyxzTXA+SPYN40SOpZRzJTxA8HeKLzCSw1Q8`、その接続元制限は既存OMEN Tailscale IPと宅内サブネットだけ。
- Tailscaleは既存プロファイルの無人運転 `ForceDaemon=true` と自動起動を維持する。設定読取りと、サインイン前の実接続確認は区別する。今回Windows再起動・サインアウト試験は行っていない。
- SurfaceからOMENへSSHし、そこでさらにSurfaceへWindows OpenSSHを実行する検証は、外側 `ssh -tt`・内側 `-n` を使う。鍵認証後の停止だけをネットワークや鍵の故障と断定しない。既存の共有AppServer・管理者窓口の権限境界は変更しない。
<a id="typesafe-configuration"></a>

## TypeSafe configuration

- When working on this project, read `.agents/skills/typesafe-ai/SKILL.md` and
  apply its guidance where semantic judgments or AI-powered features are relevant.
  Follow its live documentation before implementing a TypeSafe integration.
- Keep exact task ownership, permissions, routing, and execution in code; model
  confidence is not authorization. Installing the skill does not itself authorize
  paid inference or sending project files or conversation data to an external API.
- Configure `TYPESAFE_API_KEY` with `typesafe/Enter-TypeSafeApiKey.ps1`, following
  the official SDK environment-variable convention. The input screen explicitly
  saves it to the current Windows user's environment; that registry storage is
  plaintext. Never print the key or put it in source, logs, or command arguments.
- Already-running processes do not inherit later environment changes. Before a
  TypeSafe call from an existing terminal, import the user variable into that
  process without displaying it. Do not restart Codex or other tasks for this.
