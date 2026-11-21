# メモリ調査

```powershell
node memory-report.mjs
node memory-sweep.mjs              # dry-run
node memory-sweep.mjs --apply      # 別途一覧を確認した後にのみ実行
node --test sweep-policy.test.mjs
```

NodeがPATHにない場合は、既存のNode実行ファイルを絶対パスで指定する。Windows x64・PowerShell・既存の正準共有AppServerを使用し、新しいサーバーは起動しない。JSONはこのフォルダーの`reports/`へ出力する。外部通信は既存のloopback AppServerへの読み取りだけ。

`privateBytes`はWin32_Process.PrivatePageCount、`workingSetBytes`はWorkingSetSize。両者を加算しない。作業セットには共有ページの重複があり、候補の合計は解放できる物理RAMの保証値ではない。コマンドラインは既知の秘密引数を伏せて先頭300文字だけ保存する。環境から取得する値はthread/session IDだけで、環境全体や会話は保存しない。

threadはプロセスの明示的なthread/session IDと親子関係で対応づける。共有AppServerの親子関係、起動時刻、同じworkspaceだけでthreadを推定しない。sessionファイル先頭のメタデータもPIDとの対応がなく、PIDの根拠として使えない。特定不能・RPC失敗・未対応goal API・終了時刻欠落はunknownとして候補から除外する。notLoadedはidleとして扱わない。RVM計画とautopilot.lockは毎回読み、読めない境界では終了しない。

CPUは10秒以上離れた2回の観測で増加が0.05秒以下の場合を「ほぼ増えない」とする。短い静止は今後の停止を保証しないため、tscはコマンドラインから常に保護する。孤立node/gitもunknown除外を優先し、明示的に識別できたidle・goalなし/completeの所有threadに限る。RVMのcurrentAssignmentPlan内の全threadとremainingExecutionProgress.runningを保護する。

applyは事前一覧と、1件ごとのdispatching/終了確認/失敗を永続化する。直前にthread・goal・RVM計画・autopilot・CPU・プロセス実体を再読し、個別のプロセスハンドルの開始時刻/実行パスを照合して終了する。子孫のうちcodex/Claude/システム等が混在するグループは対象外。ツリー一括終了は使わず、子から順番に終了する。失敗または結果不明のグループは再試行しない。AppServerのthread状態とWindowsプロセス終了には共通ロックがなく、直前の読み取り後にthreadが動き始める競合は完全には排除できない。

WUDFHostはPnPインスタンスと取得可能なWUDFレジストリのPID情報、またはコマンドラインのインスタンスIDで対応づける。証拠がない場合はunknown。機器名からメモリリークの原因は断定しない。UMDFの同一ホストが複数の機器を担当する場合がある（[Microsoft](https://learn.microsoft.com/en-us/windows-hardware/drivers/wdf/umdf-driver-host-process)）。停止・無効化、イベントログの有効化、管理者への昇格は行わない。
