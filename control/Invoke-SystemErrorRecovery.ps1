param(
    [ValidateSet('run', 'dry-run')][string]$Mode = 'run',
    [string]$NodePath = 'C:/Users/lazyg/Documents/Codex/2026-09-28/rvm-recovery/toolchain-cache/node-v24.21.0/node-v24.21.0-win-x64/node.exe'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'system-error-recovery.mjs'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Recovery Node runtime is missing.' }
# Hidden current-user worker; no server, credentials, elevated token or settings override.
$worker = Start-Process -FilePath $NodePath -ArgumentList @(('"{0}"' -f $script), $Mode) `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait
exit $worker.ExitCode
