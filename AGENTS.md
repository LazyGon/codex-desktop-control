# Codex Desktop Control

本書のdocs/・state/・control/参照は、Codex homeのinstructions/host-operations.mdで確認した対象PCの正準Control root基準。

## 必須境界
正準endpointはlauncher/state/current.json。legacy experiment stateは移行時のfallbackだけ。対象選定前は既存list/catchupを優先する。既存validateSharedRuntime/connectCanonicalを使い、対象thread/最新turnを明示、元workspace/model/approval/sandbox/停止とUNKNOWN無再送を守る。別AppServerやlistener外部公開をしない。control保守でProduct repoを変更しない。
Discord秘密はDPAPI保護し引数/ログ/source/JSONへ残さず、guild/user allowlistとraw shell禁止を保つ。Bridge停止は正常停止経路。Desktop不在は正準generationと実不在を確認したsupported操作だけ許容し、Desktop所有toolにはDesktopが必要。launcherのoperator用強制停止を更新適用や不明停止の迂回に使わない。

## TypeSafe
本projectでは.agents/skills/typesafe-ai/SKILL.mdを読む。意味判断/AI機能を実装する時だけlive docsへ進み、正確な所有/権限/routing/実行はcodeに置く。skill導入は有料推論/外部送信の許可ではない。key設定時はdocs/OPERATIONS.md#typesafe-configurationを読み既存typesafe/Enter-TypeSafeApiKey.ps1を使う。keyは表示/引数/source/logへ残さず、既存processへの環境取込みで対応しCodexを再起動しない。

## remote更新
Ownerが除外しない限り、依頼されたremote更新統合はBridge再起動まで含む。live Bridgeとscheduled taskの所有を確認し正常停止→終了確認→既存Codex Discord Remote taskを一回起動、新PID/Discord readiness/共有接続を検証する。不明操作は再送しない。許可はBridgeのみでDesktop/AppServer/Windows/Ollama/他taskへ広げない。

## 管理者・再起動
Codex homeのAGENTS.mdとinstructions/host-operations.mdで対象PCの手順を確認する。管理者操作にはadmin-terminal/AGENTS.mdを、個別に許可された再起動にはdocs/OPERATIONS.md#restart-and-signinも参照する。旧ARSO helperはhost-operations.mdに記録された履歴と限定条件に従う。

## crash修復
修復前にdocs/crash-recovery.mdを読む。正準live状態とCodexRecovery/current.json・検証記録を照合し、壊れた原本・新しいUNKNOWN/accepted journalを保全する。旧snapshotで新journalやlive SQLiteを上書きしない。Bridgeの同guild backup復旧を使い空stateで再作成しない。DB復元は実writerの正常停止後だけ行う。

## commitとpush
Ownerが除外しない限り依頼の検証済みrepo変更は関連差分だけstageし、正確なstaged diffを確認して意味のあるcommitとconfigured upstreamへの通常pushまで完了する。無関係WIPを保存し、必要な同期/競合解消を行いforce pushしない。remote上のcommit identityを確認、不明pushはreadbackして再送を判断する。阻害時は未commit/未pushと具体理由を報告する。read-onlyや変更無しで空commitしない。

## task作成・配送
別local Codex taskの依頼は正準共有AppServerのthread/startを使う。Desktop/high-level create_threadは使わない。元設定/権限を維持し、exact IDのread、通常paginated list所属、Discord bindingを別に確認する。確認失敗で再作成しない。配送直前に最新turnを読み、一回expectedTurnId付きsteer又はstartを行いaccepted exact turnを確認する。threadIdだけのChatGPT send_message receiptを実配送/完了/callbackとせずgoverned review/Receiver transportに使わない。実施時はdocs/OPERATIONS.md#task-and-goal-operationsを読む。

## RVM
RVM作業ではstate/rvm-fast-operations-20261007/AGENTS.mdを読み、現在設計・役割・共通運用を使う。Product scope/受入は指定ownerに残し、通常proofの代行やpin済み履歴改変をしない。

## コマンド実行
適したread/write/APIは持続Node REPLでまとめる。Node CLIは明示cwd/argvで直接起動し、PTY表示byteをcanonical evidenceとしてhashしない。WindowsのPTY/環境/PowerShell解決/遅延を扱う時はdocs/OPERATIONS.md#windows-execution-environmentを読む。旧版のalias障害や過去のDefender除外を現環境の成功と推定せず、勝手なセキュリティ設定変更/サービス/AppServer追加をしない。

## system-error recovery
復旧を設定/診断/保守する時はdocs/system-error-recovery.mdを読む。既存正準共有serverとLimited/windowless schedulerを使い、最新typed terminal transient failureだけ同threadの元設定で扱う。active/正常完了/意図中断/停止/paused/予算制限/HOLD/UNKNOWNを復旧対象へしない。native子は真正親の所有経路で扱い直接再開しない。
排他episode journalをmutation前に保存しdispatching/UNKNOWNを再送しない。goal復帰は記録された同active goal→正確な失敗turn→blockedの既許可境界又はexact PO permitだけ。本文/予算/使用量/設定・停止/除外を維持し、新scope/外部操作/課金/再起動権限を加えない。登録/receipt/zero-eligible cycleを全inventory又は実復旧成功としない。画像原因の修復は別の確定episodeだけ既存docsに従う。

親通知の保守では同referenceを読み、正準な真正parent関係を使う。native子をordinary経路へ移さず、親の停止/paused/blocked/予算/除外を自動解除しない。active親は最新exact turnへ、idle親は既存activeで未枯渇goalがある場合だけstart。通知と子復旧のjournalを分け、不明通知で子復旧を再実行しない。

earned credit resetの設定/診断時だけdocs/credit-reset-policy.mdを読む。本人の明示許可なしにcreditResetPolicyを有効化せず、選定account/reset/閾値に束縛してUNKNOWN再送しない。購入credit復旧は明示paidRecoveryThreadIdsを要し、複数PCへ同policy/authorization/journalを複製せず元task/goal保護を守る。
