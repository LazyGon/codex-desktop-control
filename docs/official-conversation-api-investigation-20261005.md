# 公式会話APIとタスク一覧の調査記録（2026-10-05）

## 固定した範囲

Unit: Desktop 26.930.3930.0 と既存の共有App Server、およびこのrepositoryの経路境界。
Base: `1e550fd18847d4bc282205980458ea287e75f414`。既存WIPは変更しない。
Windows・現在のユーザー・既存のloopback共有構成・既存Discord allowlistを対象とする。
変更可能な場所はこの記録、AGENTS.md、README.md、discord-bridge/docs-operations.md。
上流バンドル、DB、他repository、稼働プロセス、秘密情報は変更しない。

固定した確認項目は6件:

1. C01: 旧送信を `DELIVERY_UNCERTAIN` のまま保全し、再送・再利用・回収しない。
2. C02: 公式ツールの経路と成功表示の意味を実装・時系列で確認する。
3. C03: systemErrorの責任境界と、確定できない原因を区別する。
4. C04: 添付、callback、exactly-once、Reviewer Accessor代替条件を確認する。
5. C05: 旧taskのread/list/binding差を確認し、再開しない。
6. C06: 今後のローカル別task作成を直接thread/startへ固定し、確認手順を残す。

新しい保証、依存、常駐watcher、別App Server、旧操作のretryは非対象。
秘密情報・権限・費用・外部変更が必要、または配送が不確定なら停止する。

| Finding | Frozen basis | In scope? | Evidence | Scope delta | Disposition |
|---|---|---|---|---|---|
| 公式送信の成功表示と配送証拠の差 | C02-C04、ユーザーの初回依頼 | YES | 同一call IDのログ、Desktop同梱コード | なし | ADMIT_EVIDENCE |
| systemErrorの意味と所有層 | C03 | YES | 状態変換とChatGPT fallback実装 | なし | ADMIT_EVIDENCE |
| 高レベル作成taskの一覧漏れ | C05、追加指示 | YES | 直接read成功、全ページで不在、bindingなし | なし | ADMIT_EVIDENCE |
| 必須作成経路と安全な運用境界 | C06、追加指示の明文化許可 | YES | 直接作成taskが一覧とbindingに存在 | なし | ADMIT_IMPLEMENTATION（文書） |
| 旧送信の再送・旧taskの再開 | C01/C05の禁止 | NO | 保全対象 | 禁止に抵触 | REJECT_SCOPE_EXPANSION |

## 結論と所有層

公式ツールはこのrepositoryの送信実装ではない。`launcher/codex-app-tools-bridge.mjs`
は現在Desktopとlistenerの所有者、named pipe、同梱pluginを検証し、公式pluginを起動する。
公式tools/callの結果やChatGPTのstreaming状態は加工しない。

問題のreadエラー後の成功表示は再確認できた。ただし、ChatGPT IDを最初にCodexの
thread/readへ渡すこと自体は現行Desktopの探索・fallback設計であり、それだけで誤配送や
systemErrorの直接原因とは断定できない。確定した問題は「ツール成功を配送成功として
扱えない」という責任境界である。ChatGPTの実際の生成・通信失敗の詳細はUNKNOWN。
このrepositoryで上流のstatusや成功値を書き換える修正は行わない。

別taskの一覧漏れは、Bridgeより前の共有App Serverのread/list差として再現した。
Bridgeは通常一覧からtop-level・非ephemeral taskを同期するため、その一覧に出ない
taskは通常の自動binding対象へ到達しない。特定のthreadSourceが原因である可能性は
あるが、バックエンド内部の除外条件までは確定していない。DBを修正したり、除外を
推測した全件走査や手動bindingで上流制約を回避しない。

## 旧送信の再検証証拠

対象Conversation: `6a5e1224-98f4-83ee-b4e8-71c13ad1f37d`。
ユーザー提供事実: official list/read成功、一度の送信は約7.3秒後にthreadIdのみを返した。
直後のreadでsystemError、最新ターン・メッセージ・updatedAtは不変。
これらの内容を新しい送信で再現していない。

現在のDesktop main logは次のローカル位置にある。本文・credentialは転記しない。

`%LOCALAPPDATA%/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/Codex/Logs/2026/10/05/codex-desktop-db8125bc-ce44-405e-9f5f-c46b6643c053-13596-t0-i1-000005-1.log`

| UTC | 行 | 安全な固定事実 |
|---|---:|---|
| 13:18:41.304 | 2733 | send_message_to_thread開始、call_YGxe1z38WECqJmawCgCF2iUn |
| 13:18:41.395 | 2734-2735 | 対象IDへのthread/read、-32600、thread not loaded |
| 13:18:41.813 | 2736-2737 | 同IDへのthread/read、-32603、grpcエラー |
| 13:18:48.565 | 2738 | 同一送信call IDでsuccess=true、経過7,261ms |
| 13:18:57.256-57.715 | 2741-2744 | 直後のreadでも同IDに二段階エラー |

バンドルの読取専用検査で次を確認した。
`app.asar` の `webview/assets/execution-5914859816b9.js` は送信を
`app-initial-74dc12f48352.js` の `O3s` へ渡す。O3sはCodex host探索が失敗したとき、
添付contextがなければChatGPT fallbackのHxaへ進む。

HxaはFxaへpromptを渡し、truthy結果なら `{threadId}` を返す。
Fxaの `requireDispatchAcceptance` の既定値は `onSubmitted != null` である。
HxaはonSubmittedもrequireDispatchAcceptanceも渡していない。FxaはXAiから値が
返ることを成功として扱う。toolのZはその結果をsuccess=trueに包む。
この経路はpersisted message IDやaccepted turn ID、finalを返さない。

同バンドルKxaはDesktopのChatGPT状態がerrorならsystemErrorを返す。
これはDesktop内の状態であり、サーバーの履歴・配送結果そのものではない。
従って、read探索のgRPCエラーからChatGPT生成失敗までの因果関係は未確定であり、
不変の履歴だけから未配送とも断定できない。旧送信は今後もDELIVERY_UNCERTAINで保全する。

## 高レベル作成taskの一覧漏れ

旧task: `01a10c65-c0e6-7723-87be-7690cd05a8b8`。
直接thread/readで現存とidleを確認した。source=vscode、
threadSource=agent_created_thread、projectId=null、ephemeral=false、parentThreadId=null。
interrupt済みというユーザー指示を保全し、resume/start/steerは実行していない。

通常thread/listをcursorがなくなるまで確認すると22件、旧IDは不在だった。
sourceKinds省略、空配列、vscode指定、useStateDbOnly=true、modelProviders空配列でも
旧IDは不在。スキーマで定義された非subagent sourceKindsを列挙すると56件になったが
旧IDは不在。searchTermはID検索ではなくタイトル部分一致であり、ID検索0件だけでは
不在証拠にならないため、上記は検索条件なしの全ページで確認した。

現行binaryが生成したThreadListParamsにはthreadSources filterはない。
未知のJSON fieldを渡しても効くとは扱わない。projectId省略は全project、nullは未割当、
sourceKinds省略/空配列はinteractive sourcesが既定、modelProviders空配列は全provider。

既存state DBのread-only検査で旧taskのrolloutが存在することを確認した。
has_user_event=0は旧taskと現在taskの両方にあり、単独では説明にならない。
Desktop作成コードはagent_created_threadを明示するが、sourceタグだけが一覧不在の原因と
断定する証拠はない。正常taskと旧taskの完全な対照作成実験は行っていない。

現在task: `01a10c6e-e3cf-7853-abc4-25b8d13120e1`。
ユーザー提供の直接thread/start作成と通常一覧への表示に加え、Bridge stateのbindingに
channelId=`1556672285052502046` があることを読取確認した。
旧IDのbindingはない。Bridgeが現在taskへ付けたprojectIdはcwd由来の識別子であり、
App Serverがproject_id=nullでもbindingできるため、未割当だけが原因ではない。

## 今後使う経路

### ローカルCodex別task

ユーザーの別task作成依頼には、`launcher/state/current.json` の既存endpointを使う。
Desktop高レベルcreate_threadを使わない。Bridge既存のCodexService.startThreadも直接
thread/startを使っており、この経路を維持する。

1. 現在のlistener所有者、Desktop接続、readyzを検証する。別serverを起動しない。
2. 既存 `discord-bridge/src/app-server-client.mjs` または同等の直接JSON-RPC clientで
   initialize/initializedを行う。
3. 要求されたcwdで `thread/start` を一度だけ呼ぶ。approval/sandboxを勝手に変更しない。
4. 応答のexact thread.idを保全する。無応答・切断・不確定なら再作成しない。
5. 同IDをthread/readし、通常thread/listを全ページ辿ってmembershipを確認する。
   検索語での0件をID不在と誤認しない。
6. 初回prompt配送が必要なら、現在turnを直前に読み、activeならexact expectedTurnIdへ
   turn/steer、idleならturn/startを一度だけ実行し、accepted turn IDを確認する。
7. Bridgeの通常同期でexact IDのbindingを確認する。同期は通常30秒周期とlifecycle通知で
   行われる。binding未確認を完了と報告しない。必要なら既存の/codex syncを使う。

作成、一覧、prompt受付、Discord bindingを別々に報告する。いずれかが欠けても別taskを
作って穴埋めしない。共有serverの遅延・拒否・不確定を理由に高レベルAPIへ切り替えない。
通常同期の一時的な待ちだけでturnを維持するwatcherは追加しない。

### ChatGPT公式ツール

公式list/readは履歴参照に使える。ただしエラーをCodex探索で先に受けることがあり、
最終的に返った内容・sourceを確認する。ChatGPT Conversation IDを、ローカルCodex taskの
代わりとして共有App Serverへ配送しない。

現行send_message_to_threadは厳密な配送経路としては採用しない。
既知のsystemError・threadIdのみの結果はuncertainとして保存し、自動retryしない。
公式create_threadのchatgptWorkCloud targetは普通のChatGPT会話とは別のWork cloud機能で
あり、無害canaryのためだけに別機能へ置き換えない。

### Reviewer Accessor

厳密なreview・添付・返答回収は既存browser-native transportを使う。
通常Chatの公開入口は兄弟repositoryの `DiscordReviewerAccessor.send()`、reviewの
production入口は既存の `reviewer-accessor.ps1 launch-review` とReceiverである。
既存consumer設定・公開export・current-Web preflightを維持する。
この調査では別reviewを起動せず、旧promptも渡さない。

| 要件 | 現行公式会話ツール | 既存Reviewer Accessor |
|---|---|---|
| 通常会話のlist/read | 利用可能、sourceと返却内容の確認が必要 | 公開readHistoryも存在 |
| 送信添付 | sendの公開引数にfiles/attachmentsがない | ordinary composer添付を既存契約で扱う |
| 読取添付 | 条件付きで最近のuser添付を最大10件materialize。個別失敗はallSettledで欠落し得る。完全取得保証ではない | 返答添付はexact finalとsize/hashへ結び付ける |
| accepted message/turn identity | threadIdのみでは証明できない | exact request・user-message・finalの相関を検証 |
| callback | sendにcallback登録・operation ID・completion receiptがない | review wrapperの既存Receiverが所有 |
| exactly-once | 一回の呼出しとexactly-once deliveryは別。公開idempotency/重複抑止証拠がない | 一回のinitial release、duplicate blocking、uncertainty後no retry |
| systemError時 | local error表示。配送済み/未配送はUNKNOWN | observed partial/rejected/uncertainを既存契約で有限分類 |

公式APIでReviewer Accessorを置き換えるには、同じ支持範囲でexact request/message/finalの
相関、添付の完全性、正の受付証拠、completion callbackの所有、重複抑止とno retryの
境界が実装・試験で証明される必要がある。現行ツールschemaと観測結果は満たしていない。
公式成功値を補正するshimや第二のcallback watcherは、この調査では追加しない。

## 検証と限界

現在runtimeのread-only `node launcher/codex-app-tools-bridge.mjs --probe` は
ready=true、Desktop PID=13596、version=26.930.3930.0を返した。
これはtransportの準備確認でありChatGPT生成成功の証拠ではない。

変更後の検証:

- 直接thread/listの全ページ確認: 旧task不在、現在task掲載。
- 同じ共有runtimeのreadyz: HTTP 200。
- BridgeのChatGPT service/controller/panels、client-tool router/ownership: 29件PASS。
- launcherのapp-tools bridge/config: 11件PASS。拒否ケースの診断出力も期待どおり。
- git diff --check: PASS。

これらは既存経路の回帰確認であり、上流不具合の修正証明やlive送信の完了証明ではない。
今回はrepository所有の送信・一覧処理の欠陥を特定していないため、productionコードと
恒久テストの変更は行わず、既存テストを確認した。上流の挙動を固定する擬似テストは追加しない。

上流コードはインストール済みapp.asarを読取解析した。認証情報、request body、旧prompt、
会話本文、signed URLを記録へコピーしていない。DBはmode=roで開いた。
公式Docsの [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice) は一般的な
task調整機能を説明するが、このローカル送信ツールの配送保証や本不具合は説明していない。
API PlatformのConversations/ResponsesをChatGPTの既存履歴APIと混同しない。

新しいlive canaryは実行していない。原因証拠を得るために旧送信を再現する必要がなく、
この時点で新しい外部操作やcallback待ちも存在しない。ネットワーク失敗の根本原因と
バックエンドの一覧除外条件は上流調査が必要。この文書は上流修正済み・ChatGPT送信成功・
公式経路の利用復旧を宣言するものではない。
