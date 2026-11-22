# Shared local administrator terminal

本書のdocs/・state/・control/参照はcontrol utility root（C:/Users/lazyg/Documents/ChatGPT/codex desktop control）基準。
このuserが許可した既存local queueだけを使い、TCP/HTTP/Discord shellを作らない。通常UAC登録後の既存Highest/Interactive hostを使い、password保存や自動loginを追加しない。

## 実行
正準rootはC:/ProgramData/CodexAdminTerminal。保護assetのACL/hashとcurrent.jsonのPID/実開始時刻/SID/elevated/phase、bootstrap/token証拠を確認する。既存Invoke-AdminTerminal.ps1へexact自thread/workspace/purpose/一意GUIDと監査済みlocal ps1/配列引数を渡す。guardは正準共有serverで稼働dangerFullAccess/neverの所有taskだけを認め、設定/権限を変更しない。sourceと依存を監査し秘密/会話をargvへ渡さず通常操作を昇格しない。

## 結果と不明
results/<GUID>.jsonのaccepted/dispatching/running/completed/rejected-not-executed/unknownを区別し既存IDを再使用しない。completedは実process終了で実変更の成功は別途確認する。host復帰は未完receiptをUNKNOWNにし再実行しない。host不在時は固定action/principal/hashと未完を確認して既存taskを一回だけ起動し、不明なら再送しない。長い操作は既存background workerと同thread callbackを使い、本人停止をguard readで再開しない。

## 停止・保守
明示停止は既存Stop-AdminTerminal.ps1をhostへ一回投入し、自動起動無効化と現在操作後の正常終了を確認する。installerをkillしない。更新は既許可のhash固定手順で保護ACL/旧asset/UNKNOWNを保つ。保守時はdocs/admin-terminal.mdを読む。UAC/sandbox緩和、SYSTEM流用、無関係policy変更、秘密保存、強制close、公開は禁止。Windows再起動/firmware/破壊変更は個別許可、ARSOはglobalの2026-11-22恒久有効指定に従い、旧一回限り実行経路を再使用しない。過去テストは新許可/自動sign-in実証ではない。
