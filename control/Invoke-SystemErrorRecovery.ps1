param(
    [ValidateSet('run', 'dry-run', 'status', 'stop', 'enable')][string]$Mode = 'run',
    [string]$NodePath = 'C:/Users/lazyg/Documents/Codex/2026-09-28/rvm-recovery/toolchain-cache/node-v24.21.0/node-v24.21.0-win-x64/node.exe'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'system-error-recovery-launcher.py'
$pythonw = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/pythonw.exe'
foreach ($file in @($NodePath, $pythonw, $launcher)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or $file.Contains('"')) {
        throw 'Recovery runtime or launcher is unavailable.'
    }
}
# Direct CreateProcess, independent of PATHEXT and shell-native exit tracking.
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $pythonw
$info.Arguments = ('"{0}" --mode {1} --node-path "{2}"' -f $launcher, $Mode, $NodePath)
$info.WorkingDirectory = $root
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$worker = New-Object System.Diagnostics.Process
$worker.StartInfo = $info
try {
    if (-not $worker.Start()) { throw 'Recovery worker did not start.' }
    $worker.WaitForExit()
    $result = $worker.ExitCode
} finally { $worker.Dispose() }
exit $result
