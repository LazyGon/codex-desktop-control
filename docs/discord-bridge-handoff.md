# Discord Bridge・共有AppServer 引継ぎ

更新日: 2026-11-23。対象workspaceは C:/Users/lazyg/Documents/ChatGPT/codex desktop control。
この文書は旧構築会話を新規の独立会話へ引き継ぐための記録であり、停止済みの作業や過去の許可を再実行する指示ではない。現在の必須境界はroot/global AGENTS.mdと対象領域のAGENTS.mdを優先する。

## 目的と現在の担当

Discordの同一guild・同一Botから、Surfaceとomen各PCのローカルCodexタスクを操作する。DesktopとBridgeは各PCの正準共有AppServerへ接続し、Desktopから開始した指示とDiscordからの指示を同じタスクへ届ける。
Surfaceが通常の本番運用・control保守を担当し、omenが移行済みの「猫大暴れ」を担当する。今回の移行ではSurface上の履歴・文書・公式thread APIだけを扱い、両PCのBridge設定・プロセスやomen側を変更しない。

| 項目 | Surface | omen |
| --- | --- | --- |
| 安定instanceId | DESKTOP-VVO6K2S | LAPTOP-728OIQQK |
| 表示名／役割 | Surface／本番・control | omen／猫大暴れ |
| Tailscale | 100.75.107.79 | 100.104.140.74 |
| peer endpoint | TCP 18799 | TCP 18799 |

同一guildIdは1527846107265241168、applicationIdは1527845761331494992（Codex UI）。SurfaceのローカルconfigでmultiPcEnabled=true、taskControlEnabled=true、相手peerのallowTaskControl=true、appServerUrl=nullを読み取った。相手の現在設定・稼働は今回直接確認していない。omenのinstanceIdはSurface側peer設定に記録された値である。
2026-11-23の読取り時、Surfaceのruntimeはphase=running、Discord Gateway ready、共有AppServer接続あり、Bridge PID 7200。launcher/state/current.jsonはws://127.0.0.1:8798、server PID 6464、Desktop接続確認あり、パッケージ26.1117.4957.0を記録していた。これらPID・版・状態は観測値であり、将来の操作時には必ず最新の正準記録を読む。

## 採用設計と理由

### 親Bot案から独立処理へ

最初は「先に起動したPCを親」「Discordに排他用チャンネル」を検討した。しかし各PCのタスクは独立しており、常設の親・leader election・lease・排他用チャンネルを設けない方式を採用した。Bot自体は同一でも、担当PCだけが指示を処理し、他PC宛てのイベントはACK/defer前に無視する。

旧control会話の利用者原文（rollout行534）:

> うん。排他用チャンネルもいらなくて、受け取った指令に該当するタスクがあるかPC側で見るかを実装すればいいだけでは？

同会話・利用者原文（行571）:

> 新規タスク作成は、カテゴリの中でしか実施されないのでは。カテゴリの存在是非を見ればいいのでは。
> カテゴリ作成に対応する操作はないよね？
> 一覧表示は、全PCが一覧を返して、それをマージするのはどうか

採用整理（同会話の完了回答、行609）:

> 一覧の担当PCは、その要求だけの取りまとめ役です。常設の親PCや排他用チャンネルは不要です。

通常操作はboundedなthread/readでローカルの所属を確認する。新規作成は自PCに登録されたprojectカテゴリ内の未紐付けテキストチャンネルで最初の通常メッセージを受けた時に限る。別PCのタスクID付きtopicから代替タスクを作らない。カテゴリはinstanceDisplayName付きのCodex [Surface]等で分離し、表示名を変えてもinstanceIdは維持する。
全PC一覧の要求時だけ、発言先チャンネルのownerが各peerへ並行に問い合わせ、PC名付きで統合する。停止中・timeoutのPCは未取得として表示し、空一覧や古いcacheで代用しない。

### 共有AppServer・Desktop所有

各PCのlauncher/state/current.jsonが正準endpointと世代情報を持つ。control/codex-shared.mjsのvalidateSharedRuntimeとcontrol/shared-task-operations.mjsのconnectCanonicalを再利用する。別AppServerを立てず、WebSocketはloopbackのまま保つ。
Desktopが実在し正準接続がある場合、Desktop所有のclient toolとタスク読込みを優先する。タスクのmodel、reasoning effort、approval、sandbox、cwd、goal、停止状態を無断で変更しない。配送直前に最新turnを読み、activeならexpectedTurnId付きturn/steer、idleならturn/startを一度だけ送る。accepted turnと処理完了は別に確認する。
明示server-onlyではmode=server、desktopProcessIds=[]、desktopConnectionVerified=falseが正常になり得る。同じ正準世代の実AppServerとDesktop実不在が確認できれば、一覧・読取・作成・start/steer等を代行する。PID欠落、生死不明、別世代、Desktop生存なのに接続未確認では代行しない。Chrome Use等Desktop限定機能はDesktopが必要。

### PC間通信と秘密

peer通信はTailscale上の固定route（POST /v1/tasks/list、明示有効化時のPOST /v1/tasks/operate）だけ。AppServer JSON-RPCやraw shellを公開しない。同一Bot tokenからメモリ上で導出するHMAC、送信元IP、instanceId、guild、allowlisted operator、timestamp、一回nonceを検証する。Bot tokenを持つ両Windows利用者・両PCは同じ信頼境界にある。
Bot tokenは各PCのconfig/token.dpapiにCurrentUser DPAPIとACLで保存し、Enter-DiscordBotToken.ps1の専用入力を使う。暗号文はPC間で移せず、Exporter用user tokenはBot tokenと別物。チャット・引数・JSON・source・logへ秘密を出さない。config/config.json、data/state.json、outbox、runtime、journalを他PCへ複製しない。

## コードと参照先

| 責務 | 場所 |
| --- | --- |
| Bridge起動と配線 | discord-bridge/src/index.mjs、config.mjs |
| Discordイベント・task/category対応 | discord-controller.mjs、task-routing.mjs、state-store.mjs、desktop-project-state.mjs |
| 正準接続・Codex操作 | app-server-client.mjs、codex-service.mjs、desktop-first.mjs、desktop-navigation.mjs、client-tool-ownership.mjs、client-tool-router.mjs |
| PC間一覧／操作 | task-list-federation.mjs、task-peer-control.mjs、control/codex-peer.ps1、discord-bridge/MULTI-PC.md |
| 配送と再接続回収 | delivery-outbox.mjs、delivery-outbox-worker.mjs、discord-message-recovery.mjs、codex-notification-buffer.mjs |
| 不確定書込み・削除 | task-channel-create-journal.mjs、task-mirror-deletions.mjs、data/channel-create-journal/、data/task-mirror-deletions/ |
| 表示・質問・画像 | live-activity.mjs、activity-command.mjs、async-user-input.mjs、codex-image-item.mjs、discord-panels.mjs |
| 接続障害の分類／診断 | communication-error.mjs、discord-gateway-health.mjs、discord-network.mjs、discord-rest-diagnostics.mjs |
| 共有起動・監視 | launcher/Start-CodexShared.ps1、CodexSharedLauncher.cs、CodexDesktopConnection.ps1、CodexDesktopStartup.ps1 |
| runtime保全・切替 | launcher/CodexRuntimeCache.ps1、CodexRuntimeHandoff.ps1、Complete-CodexRuntimeHandoff.ps1 |
| 利用者による終了UI | launcher/Stop-CodexComponent.ps1、CodexComponentIdentity.ps1、CodexComponentStop.ps1 |
| 運用・復旧 | docs/OPERATIONS.md、docs/SHARED-CLI.md、docs/crash-recovery.md、docs/async-wait.md、discord-bridge/README.md、discord-bridge/docs-operations.md |

表内のBridge実装のファイル名だけの参照はdiscord-bridge/src/基準、共有起動・監視／runtime保全・切替／終了UIの行はlauncher/基準。必須操作は既存AGENTSに従う。生履歴と実行証拠はignoredのstate/neko-migration-20261122/へ保存し、製品runtimeはこの引継ぎや証拠に依存させない。

## 同一IDの競合と今回の方針

同一task IDを両PCへコピーすると、ローカル所属判定は両方で成功してしまう。特に旧親01a0ceac-7cd6-7931-96a1-e350d67375f6が両PCに残り、同じDiscordチャンネルを各PCが自分のカテゴリへ戻す競合が報告された。
discord-controller.mjsのカテゴリ移動処理は、記録されたproject/archive以外への移動を拒否してbinding.categoryIdへ戻し、discord-channel-category-rolled-backを記録する。PC間で同じID・チャンネルに異なるcategoryIdを持つと、この正常な戻し処理が往復を生む。これはPOが今回の削除方針を決めた理由であり、今回両PCを操作して再現試験はしていない。
チャンネル移動・名前変更・作成はDiscordのrate limitを消費する。HTTP 429のRetry-After待ちを再起動や再送で解決しようとしない。channelCreateRestはstatusと安全なrate-limit数値を記録し、曖昧な作成・削除はjournalで再送を防ぐ。
POの現依頼によりfork独立化（DB・履歴索引の直接書換）は中止。旧controlのSHA-256は変更前バックアップのda126d432916dae6805adf67a1f37a3e8244f8636d8a705ca63bd5fb9eb419dfと実byteで一致した。変更前178,720,210 bytes、220ターン。前試行のturns=0問題は復元済みであり、独立化を再試行しない。新規会話へこの文書を最初のメッセージとして渡し、理解の応答を確認してから旧構築会話を公式thread/deleteで削除する。
旧親の削除は今回手順4に明示されている一方、Surfaceにblocked goalが残っていたため、一般除外条件との優先関係をPOへ確認中。goalを偽complete/clearする処理はしない。削除結果はPHASE-E-RESULT.mdと公式API journalが正本であり、この文書だけで削除完了とはしない。

## 運用手順

通常手動起動はCodexDiscordRemoteHost.exe／Codex Remoteショートカット、定期起動は既存のCodex Discord Remote scheduled taskを使う。内部・診断用の起動入口は次の通り（今回実行しない）。

~~~powershell
.\discord-bridge\Get-DiscordBridgeStatus.ps1
.\discord-bridge\Start-DiscordBridge.ps1
.\discord-bridge\Stop-DiscordBridge.ps1
~~~

Startは正準Node runtimeを選び、config/token.dpapiを現在利用者として復号して子process環境だけへ渡し、src/index.mjsを起動する。既存lock/PIDがあれば重複起動を避ける。通常のホスト起動と内部Startの重複使用をしない。
Stopはdata/stop.requestを原子的に置き、lockの消失を待つ正常停止。-NoWaitは同じ正常停止要求のみで、完了を意味しない。timeout後は元のPID・開始時刻の終了を確認してから次の起動判断をする。通常の更新はlive Bridgeとscheduled taskのownerを確認し、正常停止→実終了確認→既存scheduled taskを一回起動→新PID・Discord readiness・共有接続を確認する。Desktop/AppServer/Windowsの再起動許可へ広げない。
利用者の強制終了UIは別の明示操作であり、通常更新・不明な停止を迂回する用途に使わない。Stop-CodexComponent.ps1はComponent、OperationId、ResultPathと明示Forceを受け、launcher/state/component-stops/<UUID>.jsonへ保存する。実owner/SID/session/PID/開始時刻/pathを照合し、unknown/既使用IDを再実行しない。実際の強制終了は追加2会話内で試しておらず、fixtureと使い捨てprocessによる検証であった。
障害時はruntime.jsonのcodex・discordGateway・taskSync.phase/pendingThreads、append-only logs、outbox/journalを読む。readyだけで対象チャンネル・操作カード・入力配送まで成功したとはしない。state破損は原本を保全し、同guildの既存backupから復元する。空stateで作り直さず、UNKNOWNの新journalを旧snapshotで上書きしない。

## 引き継ぐ重要な経緯と限界

- 2026-09-28に独立multi-PCの導入・初回起動を確認。初期の他PC offline／同時試験未実施という報告は当時の状態であり、現状の両PC設定を保証しない。PC間操作の「終了」はタスク中断・archiveであり、相手AppServer processの遠隔停止機能ではなかった。
- Discord履歴はCodex内部状態の完全な複製ではない。オフラインPCへの通常peer readは取得不能で、復帰時のbounded readは直近16メッセージ・各4,000文字。Discordから復元したRVM後継3タスクは元IDのresumeではなく、未移送WIP・rolloutがあった。今回RVMのowner・設計・goalには触れない。
- 旧controlはBridge以外にPC保守やARSOも扱った。旧回答の「通常OptOut=1へ戻す」は2026-11-22の利用者訂正で失効し、lazygのWindows標準ARSOは恒久OptOut=0を維持する。Windows再起動は個別許可。旧一回限りworkerの再実行をしない。
- 巨大rolloutの毎回走査で一覧に数分かかった。通常一覧はuseStateDbOnly=trueで索引を読む。旧実測の54タスク230秒→0.12秒は当時の測定で、鮮度・全件性や現在の性能の保証ではない。metadataの修復走査と通常一覧を区別する。
- 通常の初期ミラーは直近最大5ターン、20ターン超の会話は最新1ターンへ有界化。履歴復元は明示確認付き1/3/7日。再接続時に巨大な画像履歴の全読取りを避け、画像補完とライブ進捗を分離した。古い16分→1分48秒という改善値は当時の実測であり、待ちの完全解消ではない。
- Gateway再接続の一部で未配送回収を起動しない不具合と、✅/パネル更新待ちが次入力を詰まらせる不具合を修正した。配送outboxと表示更新は分離する。Codex受付済みで砂時計だけ残っても指示を再送しない。元Discord投稿が消えている場合、実配送失敗と断定しない。
- 旧MSIXの登録解除時に後読みするMCP資源が消え、タスクをDesktopで開けず配送が滞った。版一致の署名・hash確認済みruntime/cacheを使って補い、次回以降に必要ファイルを保全する実装が入った。現在の稼働世代を別版の資源へ無断置換しない。
- Chrome UseにはDesktop由来のタスク読込みが必要だった。callbackがDesktopより先にthreadを読み込むとbrowser access host unavailableが出た。タスクだけの再読込みで復旧し、最終的には通常再起動後、Desktop読込みの551ms後にcallbackを一回配送しexample.comを読めた。未回答質問カードは保持し、送信中・UNKNOWNだけを保護する修正も入った。
- 進行状況は5行のコードブロック、折返し↳、省略…、実行/完了/失敗▶️/✅/❌。private reasoningは流さない。スマホの再折返しまで固定するスクロール窓ではない。表示用の単純pwsh/cmd wrapper短縮は実コマンドや保存履歴を変えない。Desktop風の活動グループ化案は利用者が不採用とした。
- thread/deletedの真正通知を先に保存してから、exact task topic・guild・channel一致を再確認してミラーを削除する。通常一覧からの欠落だけでDiscordを消さない。旧整理では削除根拠のない試験用2チャンネルを保持した。
- 11月19日の旧ログ削除は既存bindings・添付・復旧・outbox/UNKNOWNを保持して実施。投稿を残してbindingだけを安全に解除する既存操作は確認できなかった。今後もstateを編集して解除したことにしない。
- 復旧用maintenance-cold.zipはOMEN私有archive、ローカルmaintenance-cold-manifest.jsonを参照し必要payloadを元絶対pathへ手動復元するという記録がある。live DBを上書きせず、過去workerを再送しない。今回archiveの再検証・転送はしていない。

## 未完了・次の操作で再確認する点

1. 現依頼の完了条件は新会話の理解応答、旧対象へのthread/deleteと別thread/readの結果。旧親blocked条件のPO回答を保存し、PHASE-E-RESULT.mdで成否を追記する。削除失敗・UNKNOWNはそこで止め、別経路・DB書換・再作成へ進まない。
2. 旧controlの最終回答（rollout行32462）は、子Desktop processの接続成功を親ログだけの監視が見落とす不具合を扱った。原文:「今回は再起動せず接続状態と表示を正常化しました。監視コードの修正は次回の通常起動から有効です。」今回新たな再起動試験はしない。
3. GatewayのECONNRESET、TCP/TLS接続待ち・再接続timeoutが過去に起きた。切断元がPC・経路・Discordのどこかは確定していない。通常retryと高頻度handshake失敗の5分継続時の正常退出を区別し、正常接続を定期的にrecycleしない。
4. 追加完了会話のserver-only機能と利用者force終了は実装・独立試験済みだが、その会話では実サービス停止・実Discord入力・投稿をしていない。親の統合・稼働反映報告と、これらの個別未実施を混同しない。
5. 構築会話の削除は同一ID競合を解消するための今回の手段。omen側の実状態、削除後のカテゴリ移動停止とrate limit解消はPO側が扱い、今回Surfaceから勝手に確認・修正しない。

## 元会話と証拠

- control: 01a0e375-55c2-7d30-827c-0370cbd2f71d（220ターン、rollout全32,462行、完了回答213件）。
- 同目的の完了子: 01a1c8fa-04be-7163-b89d-05857dc19ec4（終了UI、圧縮rollout291行）、01a1c8f8-ee8d-7392-ab4a-0be2b732262f（Desktop不在代行、圧縮rollout208行）。いずれも最新turn completed・goalなしを正準APIで確認。
- 旧fork親: 01a0ceac-7cd6-7931-96a1-e350d67375f6。猫大暴れ履歴であり、新controlへゲームのownerや旧goalを移すものではない。既存Phase E manifestを保持する。
- ignored記録: state/neko-migration-20261122/bridge-handoff-targets.json、bridge-handoff-inventory*.json、bridge-handoff-conversation-manifest.json（構築3会話のfinal answers・rollout path/size/SHA。旧親は既存Phase E manifestを保持）、bridge-handoff-*-transcript.json。元のPhase E・復元証拠は上書きしない。
- 操作結果: 同領域のPHASE-E-RESULT.mdとbridge-handoff公式操作journal。新会話IDは01a206ef-d007-7811-9333-29a604067684。thread/startと別readは成功したが通常一覧確認で停止し、初回メッセージ・理解応答・旧会話削除は未実施。詳細はbridge-handoff-result.json。
