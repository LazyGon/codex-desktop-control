[CmdletBinding()]
param([string]$Workspace = (Get-Location).Path)

$ErrorActionPreference = 'Stop'
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\claude.exe'),
    (Join-Path $env:USERPROFILE '.local\bin\claude.exe')
)
$executable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $executable) { throw 'Claude Code is not installed.' }
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
Push-Location -LiteralPath $workspacePath
try {
    & $executable remote-control --spawn session --name 'Surface-collaboration'
    if ($LASTEXITCODE -ne 0) { throw "Claude Remote Control exited with $LASTEXITCODE. Do not start a duplicate before checking its state." }
}
finally { Pop-Location }
