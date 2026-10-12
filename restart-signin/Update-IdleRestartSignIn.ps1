param([Parameter(Mandatory)][string]$ManifestPath)
$ErrorActionPreference='Stop'
$root='C:\ProgramData\CodexRestartSignIn'
$old=Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$state=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$m=Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($state.phase -ne 'idle' -or @(Get-ChildItem -LiteralPath (Join-Path $root 'operations') -File).Count -ne 0 -or $identity.User.Value -ne $old.userSid -or $m.userSid -ne $old.userSid -or -not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Only update an unused idle installation through the verified common admin host.'}
function Hash([string]$Path){$s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','')}finally{$s.Dispose();$h.Dispose()}}
foreach($pin in $old.files){if((Hash (Join-Path $root $pin.name)) -ne $pin.sha256){throw 'Old protected asset changed.'}}
foreach($pin in $m.files){if((Hash $pin.source) -ne $pin.sha256 -or [IO.Path]::GetFileName($pin.name) -ne $pin.name){throw 'New source pin mismatch.'}}
foreach($pin in $m.dependencies){if((Hash $pin.file) -ne $pin.sha256){throw 'Dependency changed.'}}
$newNames=(@($m.files.name|Sort-Object) -join ',')
$oldNames=(@($old.files.name|Sort-Object) -join ',')
if($newNames -cne $oldNames){throw 'Asset set changed.'}
$backup=Join-Path $root 'pre-ownership-hardening';if(Test-Path -LiteralPath $backup){throw 'Revision already admitted; inspect, never replay.'}
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'config.json') -Destination $backup
foreach($pin in $old.files){Copy-Item -LiteralPath (Join-Path $root $pin.name) -Destination $backup}
foreach($pin in $m.files){Copy-Item -LiteralPath $pin.source -Destination (Join-Path $root $pin.name);if((Hash (Join-Path $root $pin.name)) -ne $pin.sha256){throw 'Copied revision mismatch.'}}
$old.files=@($m.files|ForEach-Object{@{name=$_.name;sha256=$_.sha256}});$old.dependencies=$m.dependencies
$old|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $root 'config.json') -Encoding UTF8
. (Join-Path $root 'Common.ps1')
$null=Assert-RestartInstall $root
Restore-RestartSignIn $root
& (Join-Path $root 'Invoke-RestartSignIn.ps1') -Mode Inspect
