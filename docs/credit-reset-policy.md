# 残高条件付きの無料リセット

既存の毎分の復旧処理で、購入済みクレジット残高を確認し、指定した残高以下になったら無料チケットを1枚だけ使えます。新しい常駐サービスや別の監視タスクは作りません。

標準導入では無効です。アカウント全体のリセットを消費するため、本人から条件付き自動使用の指示がある場合だけ設定してください。

## 条件

- 正準共有App Serverの現在のアカウントに紐付けます。ログイン先が変わった場合は消費しません。
- 残高は `account/rateLimits/read` が返す `rateLimits.credits.balance` のクレジット単位です。率・token数・通貨へ換算しません。
- 有限で確認できた残高が閾値以下で、通常のCodex利用枠が使用済みの場合だけ対象になります。残高不明や無制限表示では使いません。
- 既存のspend controlを保護します。
- 設定時点で利用可能なチケットから期限の早い1枚を選び、IDを固定します。2枚目へ自動で乗り換えません。期限切れを避ける目的で閾値前に消費する動作もありません。
- 1回の設定で消費するのは1枚までです。通常枠が自然に回復している間は温存します。
- 送信前に永続記録を作ります。応答不明・送信中・部分記録は再送しません。確認済みの「対象枠なし」「チケットなし」は同じ利用期間で繰り返しません。
- 課金購入や自動チャージは行いません。

## 設定

通常の復旧設定 `config.json` がある環境で実行します。公開リポジトリの標準保存先は `.local/` です。元のcontrol utilityでは既存の復旧状態ディレクトリを使います。

```powershell
node .\control\credit-reset-settings.mjs configure --threshold 10000
node .\control\credit-reset-settings.mjs status
```

この設定だけでは、通常枠が尽きた後の有料クレジットによる自動再開を許可しません。既存クレジットでの継続も本人が許可した場合だけ、正確なthread IDを追加します。

```powershell
node .\control\credit-reset-settings.mjs configure --threshold 10000 --paid-thread "AUTHORIZED_THREAD_ID"
```

`--paid-thread` は複数指定できます。許可したタスクだけ、残高が閾値を上回っている間、既存クレジットを使ってシステムエラーから再開できます。ゴールの停止・予算・担当・権限保護は変えません。閾値は毎分の観測で判定するもので、進行中ターンや他端末の支出を停止する厳密な残高下限ではありません。

既存の有効な設定は上書きしません。条件を変更する場合は、現在の状態と未確定操作を調べ、無効化してから明示的に設定し直してください。

```powershell
node .\control\credit-reset-settings.mjs disable
```

この解除は条件付きのチケット消費と有料自動再開の許可を止めます。通常の復旧処理や進行中のタスクは停止しません。復旧全体を止める既存のstopも有効です。

## 状態と記録

通常の `last-cycle.json` に `creditPolicy.action` を追加します。生の残高やアカウント情報は周期ログへ出しません。

- `holding-above-threshold`：閾値前なので温存中。
- `included-usage-not-exhausted`：通常枠が残っているので温存中。
- `redeemed` / `already-redeemed`：1枚の使用を確認済み。
- `completed-one-reset`：今回の許可分は終了。
- `unknown-no-resend`：結果不明。再送せず確認が必要。
- `selected-reset-unavailable`：選んだチケットを確認できない。別のチケットには切り替えない。

`credit-resets/` の記録は削除・上書きして再実行させないでください。同じアカウントで複数PCが動く場合、この条件付き消費の設定は担当PC一台だけで有効にしてください。他PCの認可や記録をコピーしないでください。

設定中のアカウント・チケットIDと認可はローカル設定です。Gitへ追加しないでください。詳細なAPIは [公式App Server仕様](https://learn.chatgpt.com/docs/app-server) を参照してください。
