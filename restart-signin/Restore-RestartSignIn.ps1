param([switch]$Cancel)
. (Join-Path $PSScriptRoot 'Common.ps1')
Restore-RestartSignIn -Root $PSScriptRoot -Cancel:$Cancel
