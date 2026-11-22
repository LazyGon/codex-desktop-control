# RVM作業別リファレンス

適用範囲のAGENTSにある必須原則を前提に、対象作業に必要な節だけ参照する。履歴や例は新しい権限・製品契約を追加しない。control相対pathは C:/Users/lazyg/Documents/ChatGPT/codex desktop control 基準。

<a id="worker-retirement"></a>

## 一時workerの整理

## 一時workerは成果の退避・検証後に削除する（2026-11-21 利用者訂正）

以後使わない一時workerは、成果の対比→不足成果の退避→検証→公式のthread削除の順で整理する。アーカイブで代用せず、会話記録・rolloutの退避や圧縮は行わない。対比表は `../thread-retirement-20261121/`、不足成果の退避先は同所 `results/<threadId>/`。commit・差分・result/final・必要証拠が統合commit又はstate内に欠けなくあることを確認する。既存state成果はpinのみ。worktreeだけの必要成果はコピーし元hashと一致を確認する。未push/未統合commitは通常push/readback、できなければbundle（verify）又はpatchで退避する。

統合owner・元管理・RVM以外、active/blocked、未解決割当て・UNKNOWN・保留配送、継続予定又は一条件でも未確認のthreadは残す。削除直前に最新turn/goalを読む。取込み済み又は後続へ引継ぎ済みと確認したものだけ、公式AppServer API又はCodexの正規削除操作で最大5件ずつ削除し、正準list/readで毎回確認する。直接のDB/session/rollout削除、再起動、設定変更、失敗/不明の再試行は禁止。公式経路が無ければ削除せずinboxへ一件出す。

削除後は所有していたnode_repl/cua_node等の残存も確認する。所有を断定できないprocessや他担当は止めず、残るPID・親・起動時刻をinboxへ返す。結果reportは削除件数/対比表pin/残した理由/使用経路と `retiredThreads` を含める。新threadのcredit登録reportは `newThreads` を使う。有限goal完了後の随時整理も同じ手順とし、新ACK/watchは作らない。

<a id="common-tools"></a>

## 共通ツールと入力

共通ツールは state/rvm-fast-operations-20261007/ にある。common-tool-catalog-r1.json の元pinと実fileを照合し、後続指定があるものは以下の選択版を使う。pin済み旧実装とjournalは変更しない。

| 用途 | 選択部品 |
| --- | --- |
| 実byte/hash、排他保存、原子journal | operation-io.mjs |
| 最新exact threadへの一通知 | task-notice-r3.mjs / task-notice-batch-r4.mjs |
| 明示割当て | task-dispatch-r2.mjs（現在ownerの51単位割当て経路内のみ） |
| 管理判断の互換配送 | manager-delivery-r2.mjs |
| 子process・raw記録 | bounded-process-2h-r1.mjs |
| guard付き実行 | 既存guarded-gateの選択版とsession adapter |
| canonical実行結合 | execution-join.mjs、executionSchemaとexact driver tokenを明示 |
| Git request-base読取 | product-observation.mjs |
| 製造時間集計 | manufacturing-metrics.mjs |

## 利用方法

- CLI形式は選定Nodeで`manager-delivery-r2.mjs CONFIG.json CONFIG_SHA`、`bounded-process-2h-r1.mjs CONFIG.json CONFIG_SHA`、又は選択済みguarded-gateへSPECとSHAを渡す。
- pinは`{file, sha256, byteLength}`。実byteを読む。mtimeや文書存在だけで証拠・権限を代用しない。
- 配送config: schema=`rvm-r5-manager-delivery-config/v1`、`productRoot`、decision/messageのpin、未作成のjournal file。noticeはdecisionのexact file/SHAを含め、要点・次の手・保持条件を短く記す。
- process config: schema=`rvm-bounded-process/v1`、executable pin、args、cwd、未作成outputDirectory、timeoutMs、maxBufferBytes、任意の入力pin配列。秘密をargvに渡さない。
- gate spec: schema=`rvm-r5-guarded-gate/v1`、gate、captureConfig pin、session directory、未作成outputDirectory、command。commandは前記process configの実行部分で、入力pinを明示する。
- 共通ツールのsourceと選定実行fileをcatalog/入力pinに結合して使う。受入ownerは実canonical originを結合する。Process exit0やhelper PASSはProduct受入ではない。
- helperにない契約差は小さな明示adapterとして残す。stdout-only/concat、旧入力の再照合、nullable failure、exact selector等を勝手に統一しない。
- canonical joinは`executionSchema`を明示して新gate版を選ぶ。`driver`は実command配列のexact token（shell wrapperならexact invocation token）を指定する。曖昧な部分文字列でscriptを認定しない。

## 並列担当の再利用とnative子上限

2026-10-11前向き訂正: 新しい既存担当への同thread配送は `task-notice-r3.mjs` / `task-notice-batch-r3.mjs` を使う。既存のBOM対応正準接続adapterを再利用し、R2の権限・model・最新canonical・排他journal・UNKNOWN再送禁止を保持する。旧R2/配送履歴は不変。並列batchの4はRPCの同時接続幅で、独立担当の総数制限ではない。新assignmentの実開始はaccepted turnと設定読み戻しで確認し、POの停止・再開順序を配送前提として守る。

### 2026-10-11: 未送信preflightの有限接続復旧

新規の複数担当配送には `task-notice-batch-r4.mjs` を使用できる。R3 notifierの既存preflight、排他journal、exact latest、UNKNOWN無再送を維持し、正準共有clientの既存 `requestTimeoutMs` だけを30–120秒の有限範囲で指定する。通常は30秒、RPC並行数は最大4。大きい履歴の `thread/resume` が30秒で失敗し、journalが `preflight_failed_no_send` の場合だけ、未送信の初回依頼を新journalへ接続復旧として移す。送信済み又は `dispatching`/不明は再送しない。実canonical入力へ結合して実状態を確認する。既存R3と旧journal/pinは不変。運用timeoutはProduct deadline、権限、モデル、scopeを変更しない。

### 実行期限の選択

作業用最大実行期限は7,200,000ms。既存 bounded-process-2h-r1.mjs 等の選択済み2h部品を使い、外側wrapper/case/hookに旧240/360秒の先行中断を残さない。正常終了・確定失敗・本人停止には即応する。Productの安全期限と通知期限は別。変更不能な外部制限は具体的に報告する。既存pin/journalを書き換えず新規処理へ適用する。

<a id="design-improvement"></a>

## 新しい設計不足の後段展開

## 実装不足点の後段設計全体への展開（2026-10-08 PO指定）

POは、今後も実装担当が新しい不足点を提示するたびに、それを観点化して後段設計全体を再調査するよう指定した。
管理は当該itemの修復だけで終えず、次を同じ運用で実施する。

1. 新materialの実byte/hashと選択済み契約を読み、最初の不足predicateを確定する。設計不足、実装不一致、証明・実行能力不足、正常な後段phaseの未活性を分ける。後段機能の不存在だけを設計欠陥にしない。
2. 実装の現在位置を正準状態から確認し、凍結台帳の全後段itemを新観点でスクリーニングする。直接のafter依存だけでなく、同じschema/State epoch/origin/ID/codec/private port/consumer/表示hash/publication rootを共有する横断itemと隣接境界も対象にする。
3. 該当群は選択済み原文・exact owner/path・旧互換/replay・producer phase・独立導出・実経路受入まで深掘りする。全体coverageと、対象/非対象の根拠を残す。変更が及ばない確認済みsource/判断はpin付きで再利用し、同byteの再試験・全matrix・機構往復を増やさない。
4. 同じrootの複数不足を一つの有限後継案へまとめ、明示変更条項/最小path/依存順/compatibility/必要な正負例を管理が採否する。調査子はproposalだけを出し、grant・Product受入・immutable freezeの書換えをしない。実装済み面の通常proofは確認専任が所有する。
5. 新観点と再発防止条件を継続台帳へ追加し、後段item到達前に解消する。局所判断はR5の一immutable decision＋両owner各一配送で返し、未解決の横断設計は管理配下の分担で続行する。未知/不明配送/旧findingは再送しない。

現在のowner/割当てはRVM共通AGENTSを使い、旧25担当の配分や旧配送を自動再開しない。旧計画と結果はstate/rvm-design-preflight-20261008/とstate/rvm-verification-feedback-20261009/に保全されている。

<a id="process-metrics-and-audit"></a>

## 進行・製造時間の確認

### 今後の実測（2026-10-08 PO確認）

既存のrequest/delivery/process/admission/受入記録の時刻とpinを使い、通常の判断配送・item受入時に次を集計する。計測だけの追加test、RPC、ACK、watcher、heartbeatや定期pollingは作らない。

- 判断応答時間: 新requestの管理への実配送時刻から、そのrequestに結合した判断の両owner実配送完了まで。設計・処理時間も含む応答時間であり、全区間が実装停止だったとは推測しない。
- 失敗実行時間: itemと関連修復の既存child receiptのfailed elapsedMs。重複実行記録を除外し、Product失敗・環境失敗・観測能力不足は元区分を保持する。
- item完了時間: 実専用incomingの通常入場から、確認専任がそのitemの受入を成立させた実completed-finalまで。限定WIP受入・task_completeだけをitem完了にしない。未完は未完、開始/終了不明は未計測。

item/root・関連request・入力版を結合し、改善前後の中央値と件数を見る。入力やrequired proofが異なる標本は同条件の倍率へまとめない。履歴からの初期値と今後の測定を分ける。

製品の正誤・oracle・受入の意味は受入ownerに残す。製造監査は現行Claude経路で、旧schedulerを起動しない。通常結果の差分から工程順・配分・待ち・失敗・手戻りを判断する。計測・監査設定時はdocs/claude-orchestration-metrics.mdの対象節を使う。旧独立進行監査は停止中で、この文書は再開許可ではない。

<a id="review-and-delivery"></a>

## レビューと配送

### 完了後に残るAppServer systemErrorの配送（2026-10-09）

新規管理配送は `manager-delivery-r2.mjs` を使う。旧pin済み `manager-delivery.mjs` とno-send journalは保持する。
正準launcher JSONがUTF8 BOMを持つ場合は、同R2の既存dependency引数へ `state/rvm-completion-r4-20261005/goal-response-source-scope-r5-r1/same-item-appserver-connection-r2.mjs` の `connect/latest/identity` を渡す。配送のrole/cwd/model/権限/最新turn照合と排他journalはR2本体で維持する。旧module・launcher bytes・失敗記録を改変せず、推測endpointや別AppServerへ切り替えない。
R2は、実statusがsystemErrorでも正準最新がtask_complete又はturn_abortedで、同thread/cwd/model/権限/思考量と配送直前のstatus・正準recordが一致する場合だけ、同threadへ一回turn/startする。実statusとterminalSystemErrorをjournalへ記録し、idleへ偽装しない。非terminal・不明状態は拒否し、RPC不明は再送しない。この差分はProduct grant・受入・新watchを追加しない。

R902のレビューgoalはactual-finalと両owner初回配送を確認して完了済み。記録はstate/rvm-reconciliation-20261011-r1/manager-goal-resume-20261012-r1/seq17-ex01-private379-parent-review-r902-r1/。保存済み元goal・旧UNKNOWNを再開/再送しない。将来の有限レビュー配送はその明示scopeだけで扱い、一般goalへ旧義務を追加しない。

<a id="progress-publication"></a>

## 進捗表の更新

## 全量進捗表の更新と項目固定（2026-10-28 利用者指定）

2026-10-29訂正：当時の47工程の主表示は「実装・共有統合・検証」の独立3軸とする。正式受入0/47や「限定検証」一語を途中進捗の代わりにしない。各seqの `fullProgressInventory.rowUpdates[seq].phases` に各軸の `key/detail/proof` を保存し、次に更新する際も現在の根拠から維持・前進・差戻し・未確認を更新する。`next` は現在の具体的な残作業。差分提出は工程全量実装済みと区別し、部分反映・局所確認・実経路一部を全量へ昇格しない。taskのturn完了やgoal nullだけから3軸を決めない。適用範囲付きの通常結果・提出差分・実入口証拠を結び、不明を0/未実装へ変えない。表示値の辞書は既存publisherの `progress-phases.mjs`。3列の集計は重複する工程数で、合算・平均・工数率へ変換しない。全295工程/405要件・当時47工程の固定項目と必要作業は増やさない。過去の単一状態表示は履歴/証拠の分類として保持する。

利用者が求める進捗は、直近の局所作業だけでなく、現在担当と後続を含む全必要作業、各seqの実装済み・対応中・残作業、検証・受入と全体の集計である。正準の初回一覧は `joint-seq-acceptance-20261027/full-progress-inventory-20261028/FULL_PROGRESS_INVENTORY.json` の295工程・405要件。元seqの対応を組み替えず、過去の元工程受入、現在の限定証拠、実装中、未照合を分ける。未照合を未実装、限定PASSを全工程完了へ変換せず、根拠のない実装率を作らない。

- 初回一覧の項目と必要作業を固定する。以後は既存項目の状態・証拠・残条件を更新する。項目追加、必要作業又は完了条件の実質的な増加が避けられない場合は、この利用者との会話で設計相談してから反映する。既存項目の詳細へ新作業を隠して追加しない。`entry-baseline.json` は表示一覧の項目固定であり、Productの新gateではない。
- **利用者が状況を尋ねた時と、定期監査を実施する時は毎回更新する。** 正準共有AppServerの元実装の現在turn・直近報告と、前回以降の既存通常結果を読む。追加Product試験や担当へのACK要求はしない。根拠を保存し、同dir上位の `JOINT_ACCEPTANCE_PROGRESS.json` の現在工程・完了部分・残条件を共通IOで更新する。新しい正式結果がない時は担当報告として区別する。
- 全体表へ反映できる個別差分は `JOINT_ACCEPTANCE_PROGRESS.json` の `fullProgressInventory.rowUpdates` に元seq番号をキーとして保存する。使用する表示fieldは `state`、`worked`、`working`、`remaining`、`currentAccepted`、`proof`。`proof` は `{source: pin, pointer, label}` の配列で通常結果等へ結ぶ。正式な元工程全量の受入根拠なしに `currentAccepted=true` にしない。元の必要作業・分母はこの更新で変えない。
- `currentWork.reportTitle`、`reportDone`、`reportRemaining` は画面向けの短い自然文。元のsource pin・現在工程・scope限定を保持する。現在対象のseqは `currentWork.relatedSequences` で示す。単なるtimestamp更新を進捗の確認済みにしない。
- 台帳更新後、既存Nodeで `joint-seq-acceptance-20261027/full-progress-inventory-20261028/build-static-progress.mjs` を一回実行する。同じ専用配信先 `site/data/` のJSONを共通IOで原子的に更新し、`latest-publication.json` と実URLのJSON応答を確認する。HTML本体と進捗データは分離し、同じURLを維持する。
- 閲覧URLは `https://surfacebook2.tailc3bd2a.ts.net/rvm-progress/`。既存Tailscale Serveのこの専用パスだけを使う。各更新で配信設定や管理者操作を繰り返さない。新watch・ACK・heartbeatを作らず、監査の既存起動条件、利用者によるgoal停止、後段HOLDを変更しない。
- **画面を更新したことを理由に、ここでの文面報告を減らさない。** 全体で閉じた範囲、現在位置、前回からの変化、残作業と次の通過条件を引き続き自然文で報告する。リンクだけ、局所のPASS数だけで済ませない。
- 更新が失敗した時は、直前の表示を新しい確認結果として扱わず、具体的な失敗と最終の確認時点を報告する。旧記録・旧配送・UNKNOWNは再送しない。

現在の既受入47と後続232工程/51単位を混同しない。上記の元seq/表示軸は進捗の記録形式であり、新しい製品gateや現在scopeを定めるものではない。

<a id="review-method"></a>

## 関連範囲の意味レビュー

既知findingを探索の入口にし、対象契約のproducer、全consumer、operation variant、lifecycle、same-family selector、Event/reducer/replay、表示/public consumerと元testを同じpassで確認する。全入出力・effects/post・正常/拒否oracleを独立に導出し、source→contractの逆照合を行う。未読・未回復・後段未活性を区別し、一覧やhash一致だけで意味確認済みにしない。Recursive 3:15の原文はRVM共通AGENTSの保持節を参照する。

<a id="acceptance"></a>

## 受入の区分

同一ownerの設計/実装/必要検証/仮受入と、独立whole-product正式受入を区別する。固定最終byteの全owned範囲を最後の修正後に一巡し、必須不備・必須未確認を閉じる。有効な同byteの一巡/未変更proofは再利用する。通常proof・受入の代行、新しい管理gateやACKを追加しない。最終 independent-acceptance / final-windows / final-ubuntu は必須。元確認taskは停止中で、旧callback・旧assignmentを資料読取だけで再開しない。
