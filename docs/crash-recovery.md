# Crash recovery

## Local recovery copy

The current PC records its verified recovery snapshot in
`%LOCALAPPDATA%/CodexRecovery/current.json`. This registry and the snapshot are
local-only; they contain paths to private histories and credentials and must not
be published. The snapshot is not a Windows image or an off-device backup.

The 2026-10-22 snapshot contains the Codex profile's root files, session and
archived-session histories, installed personal skills and automations, consistent
SQLite backups, control-utility source and launcher cache, Bridge configuration
and data, and the crash-recovery evidence. It excludes unrelated product
repositories, large RVM working state, `node_modules`, and Windows installation
files. Restore dependencies from their normal supported installation if needed.

## Bridge state recovery

`StateStore` retains the previous two successfully read/written generations as
`discord-bridge/data/state.json.bak` and `.bak.older`. Copies are retained through
hard links before the writer atomically replaces the primary file, avoiding an
extra full-state data copy on every streamed update. They are earlier recovery
points, not a guarantee of the newest write surviving a hardware failure.

At startup, a missing or malformed primary may recover from a readable checkpoint
with the configured guild and a supported state schema. A corrupt primary is
preserved under a unique `.corrupt.*` name. A readable foreign-guild or newer-schema
primary is never replaced with an older checkpoint. Without an eligible checkpoint
startup refuses to reset visibility or recreate mirrors.

Automatic fallback changes only the Bridge state file. It does not restore or
replay channel-create journals, delivery outboxes, admin operations, scheduler jobs,
or task inputs. Those records remain independent and must retain UNKNOWN fences.

## Larger recovery

1. Read the local registry, verification record and live launcher state first.
   Confirm which writer/file actually failed; do not rerun a historical job.
2. Preserve the damaged primary and all newer operation journals. Never restore
   an entire old data directory over newer accepted/unknown operation evidence.
3. For a Bridge-only failure, preserve shared AppServer/Desktop and use the normal
   graceful Bridge stop before any explicit state replacement. Validate the backup
   guild, channel bindings and ACL, then start the fixed Bridge task once.
4. Do not copy SQLite databases over running AppServer/Desktop writers. A larger
   restoration requires a separate reviewed operation with normal writer shutdown,
   latest user settings retained, and same-task continuation prepared first. Use
   the consistent database copies, not an arbitrary copied WAL/main-file mixture.
5. Treat saved PIDs and endpoints as historical observations. Rediscover the
   canonical runtime and verify Desktop/Gateway connectivity and exact bindings.
   Reconcile Discord-side accepted operations before a new forward operation.

A backup made while applications run does not establish a single transaction
across all files. Session copies may end at an append boundary, databases are
individually consistent, and state/config copies reflect their individual copy
times. A second independent disk is required to protect against failure of the
PC's physical storage.
