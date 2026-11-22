# 開発原則の根拠と履歴索引

適用範囲のAGENTSにある必須原則を前提に、対象作業に必要な節だけ参照する。履歴や例は新しい権限・製品契約を追加しない。control相対pathは C:/Users/lazyg/Documents/ChatGPT/codex desktop control 基準。

## 責務・契約を判断する例

仕様の全文をruntimeからimportしている場合、importの存在だけでは搭載理由にならない。consumerが使う最小の実行定義と、説明・証拠を分ける。schemaという名前だけで必要な保存形式を消さず、圧縮・JSON移動だけで整理完了にしない。

不要な検査を除く時は、その検査専用のwrapper・引数・公開口・状態までconsumerを追う。元要件に必要な安全性や互換性は維持し、テストの失敗だけを根拠に製品を変更しない。独立した正常値・拒否値と実経路の確認を、対象契約に必要な範囲で選ぶ。

質問は回答によって決まる挙動と見た目を先に特定する。既に決まった仕様は聞き直さず、実装者が決められる寸法や方式は具体化する。

<a id="rvm-case-history"></a>

## RVMで得た設計上の教訓

### 事例・不足点・必要な対応

| 事例 | 管理・設計側の不足 | 必要な対応 |
| --- | --- | --- |
| source closure、application、HUMAN source proofなどのhash前像が未確定 | fieldの存在を確認して、全前像・順序・導出元・比較時点を閉じなかった | 完全な前像と型、各値の真正な選択規則、birth/currentの切断点、phase間同値、別domainとの区別をissuerと独立validatorへ同時に結ぶ |
| Event入力schemaとstored schema、ordinary childとmachine専用supplierの混同 | 類似名や参照先だけで、実consumerの種類・creator・版・保存形まで照合しなかった | 入力／保存／出力を別々に確認し、完全fieldと真正な版別dispatchを固定する。旧版を保存し、null、cast、alias、field数で不整合を隠さない |
| checkpoint marker、originのexhaustive表、protected portが許可path外 | 意味上の設計を実owner・登録・consumer・テストpathへ最後まで結ばなかった | producerからreader/cache/replayまで実pathを追い、必要な最小scopeと所有者・順序を明示する。文書だけで変更権限や受入を推定しない |
| 過去のaccepted actionとCURRENT outputの証明など、shapeはあるが純粋導出が不足 | 完全な関数の入力・選択・全effects/post・拒否条件を具体化する前に凍結した | 全rule/guard順を保持して一工程全体を独立再構成する。未来producer未活性をpure定義不足の免除にせず、caller digestやconstant-noneを証明にしない |
| 小さな訂正の連続配送と、同じfirstRemainingが残る部分提出 | 局所を直し、同工程・共有rootの隣接不整合をまとめて閉じなかった | 判明済み不足を一つの判断と関連batchへまとめ、全出力/post/oracleまで通す。訂正を読む費用、判断待ち、再試験も手戻りとして扱う |
| PO申告のサーバー過負荷3連続によるgoal停止、実読取でblocked | 実行環境の停止と、目的の完了・設計上の行き詰まりを分けた継続管理が必要 | 保存済み進捗・実goal・正準最新turnと原因を確認し、許可済みの同担当作業をmaterial progressから続ける。漫然と再試行せず、利用者の停止／再開順序、権限、UNKNOWN再送禁止を保持する |


成功・失敗・運用上の詰まりを、同根の後段consumerに適用できる有限な改善へ結ぶ。sourceの保存、意味の照合、反映、actual検証、受入を別に扱う。通常記録で効果を確認し、未計測の短縮率を主張しない。

<a id="instruction-history"></a>

## 指示の履歴と復元

旧seq17限定/HOLD、旧12担当・精査lane、旧監査周期は現行の47工程受入・232工程/51単位・Claude指揮へ置換済み。旧監査のconfig.enabledだけで再開しない。

依頼T適用前の正本byteは `state/instruction-cleanup-20261122/backup/manifest.json` と個別コピーに保全。globalの後続ARSO訂正は `backup/F001-AGENTS-before-apply.md`。各source hashと適用後hash・判断・公開commitは同dirのapply-result.jsonに記録する。固定snapshot、配布source、過去worktree、失敗/UNKNOWN journalは書き換えない。

復元は当該instruction-only commitの通常revert又は個別backupとの差分で行い、他ownerの後続変更を上書きしない。global/ignoredは該当節だけ戻す。全snapshotを被せて新しいgoal/journal/UNKNOWNを失わせない。
