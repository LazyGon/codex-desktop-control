# Migration

The checkout is relocatable. After moving or cloning it to a new directory,
rerun the root `Install.ps1`. The installer rebuilds the launcher in the new
location and rewrites the Start menu, desktop, taskbar, Scheduled Task, and
Discord Bridge launcher paths.

Quit any existing Codex Desktop session normally before starting Desktop from
the newly installed **Codex Shared Server** shortcut. No installer or migration
step terminates an unrelated Desktop or app-server process.

Local configuration, DPAPI credentials, logs, task/message ledgers, generated
binaries, and cached Codex executables are intentionally not migrated through
Git. Preserve or copy them separately only when moving an existing installation
for the same Windows user.
