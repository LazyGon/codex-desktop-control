param([ValidateSet('Inspect','Execute')][string]$Mode='Inspect',[string]$AuthorizationPath,[string]$PostbootJobPath,[switch]$Cancel)
$ErrorActionPreference='Stop'
$root='C:\ProgramData\CodexRestartSignIn'
$config=Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($pin in $config.files){
    $s=[IO.File]::OpenRead((Join-Path $root $pin.name));$h=[Security.Cryptography.SHA256]::Create()
    try {$actual=([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','')}finally{$s.Dispose();$h.Dispose()}
    if($actual -ne $pin.sha256){throw 'Protected implementation hash changed.'}
}
if($Cancel){& (Join-Path $root 'Restore-RestartSignIn.ps1') -Cancel}
else {& (Join-Path $root 'Invoke-RestartSignIn.ps1') -Mode $Mode -AuthorizationPath $AuthorizationPath -PostbootJobPath $PostbootJobPath}
