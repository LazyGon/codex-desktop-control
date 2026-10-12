$ErrorActionPreference='Stop'
function Read-RestartJson([string]$Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Save-RestartJson([string]$Path,$Value) {
    $tmp=$Path+'.'+$PID+'.tmp'
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 14))
    $stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Get-RestartHash([string]$Path) {
    $s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create()
    try {([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','')} finally {$s.Dispose();$h.Dispose()}
}
function Assert-RestartInstall([string]$Root) {
    if([IO.Path]::GetFullPath($Root) -ne 'C:\ProgramData\CodexRestartSignIn'){throw 'Unexpected protected root.'}
    $config=Read-RestartJson (Join-Path $Root 'config.json')
    if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $config.userSid){throw 'Wrong Windows account.'}
    foreach($pin in $config.files){if((Get-RestartHash (Join-Path $Root $pin.name)) -ne $pin.sha256){throw 'Protected source changed.'}}
    return $config
}
function Assert-RestartDependencies($Config) {
    foreach($pin in $Config.dependencies){if((Get-RestartHash $pin.file) -ne $pin.sha256){throw 'Shared dependency changed; review before use.'}}
}
function Get-SignInFacts([string]$Sid) {
    $p=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System')
    $w=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon')
    $u=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO\'+$Sid)
    try {
        $opt=if($u -and ($u.GetValueNames() -contains 'OptOut')){@{present=$true;value=$u.GetValue('OptOut');kind=[string]$u.GetValueKind('OptOut')}}else{@{present=$false;value=$null;kind=$null}}
        [pscustomobject]@{optOut=$opt;disabledPolicy=$p.GetValue('DisableAutomaticRestartSignOn',$null);securityPolicy=$p.GetValue('AutomaticRestartSignOnConfig',$null);permanentAutoLogon=($w.GetValue('AutoAdminLogon',$null) -eq '1');plaintextPasswordPresent=($w.GetValueNames() -contains 'DefaultPassword')}
    } finally {$p.Dispose();$w.Dispose();if($u){$u.Dispose()}}
}
function Assert-ArsoCompatibility([string]$Sid) {
    $f=Get-SignInFacts $Sid
    if($f.disabledPolicy -eq 1 -or $f.permanentAutoLogon -or $f.plaintextPasswordPresent){throw 'ARSO policy blocks use or permanent autologon exists; do not override.'}
    if($f.optOut.present -and ($f.optOut.kind -ne 'DWord' -or $f.optOut.value -notin 0,1)){throw 'Unexpected user ARSO setting.'}
    # Do not relax the default encrypted-device requirement or suspend encryption.
    $v=Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Filter "DriveLetter='C:'"
    if(-not $v){throw 'Encryption compatibility unverified.'}
    $s=Invoke-CimMethod -InputObject $v -MethodName GetProtectionStatus
    if($s.ReturnValue -ne 0 -or $s.ProtectionStatus -ne 1 -or -not (Confirm-SecureBootUEFI)){throw 'Required protected-device state unavailable; no security-policy override.'}
    return $f
}
function Restore-RestartSignIn([string]$Root,[switch]$Cancel) {
    $config=Assert-RestartInstall $Root
    $lease=Read-RestartJson (Join-Path $Root 'current.json')
    $token=[Security.Principal.WindowsIdentity]::GetCurrent()
    if(-not ([Security.Principal.WindowsPrincipal]::new($token)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Restore requires the installed approved admin path.'}
    if($lease.phase -eq 'idle') {
        Save-RestartJson (Join-Path $Root 'restore-check.json') @{phase='idle-no-change';observedAt=[DateTimeOffset]::Now.ToString('o');pid=$PID;userSid=$token.User.Value;elevated=$true;settingChanged=$false}
        return
    }
    $id=([Guid]$lease.operationId).ToString()
    $file=Join-Path $Root ('operations\'+$id+'.json')
    $op=Read-RestartJson $file
    if($op.userSid -ne $config.userSid -or $op.operationId -ne $id){throw 'Lease identity mismatch.'}
    $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
    if($op.phase -notin 'prepared','optout-enabling','optout-enabled','restart-dispatching','restart-request-accepted','restart-not-accepted','unknown-do-not-repeat'){throw 'Lease phase is not restorable.'}
    $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO\'+$config.userSid,$true)
    try {
        $current=Get-SignInFacts $config.userSid
        $atBaseline=($current.optOut.present -eq $op.originalOptOut.present -and $current.optOut.value -eq $op.originalOptOut.value -and $current.optOut.kind -eq $op.originalOptOut.kind)
        if(-not $atBaseline){
            if(-not $key -or $current.optOut.kind -ne 'DWord' -or $current.optOut.value -ne 0){throw 'User setting changed independently; do not overwrite it.'}
            if($op.originalOptOut.present){$key.SetValue('OptOut',[int]$op.originalOptOut.value,[Microsoft.Win32.RegistryValueKind]::DWord)}else{$key.DeleteValue('OptOut',$false)}
        }
    } finally {if($key){$key.Dispose()}}
    $verified=Get-SignInFacts $config.userSid
    if($verified.optOut.present -ne $op.originalOptOut.present -or $verified.optOut.value -ne $op.originalOptOut.value -or $verified.permanentAutoLogon){throw 'Restore actual-state verification failed.'}
    $op.phase=if($Cancel -or $boot.Ticks -eq ([DateTimeOffset]$op.previousBoot).UtcDateTime.Ticks){'restored-canceled'}else{'restored-after-logon'}
    $op | Add-Member -NotePropertyName restoredAt -NotePropertyValue ([DateTimeOffset]::Now.ToString('o')) -Force
    $op | Add-Member -NotePropertyName observedBoot -NotePropertyValue ($boot.ToString('o')) -Force
    Save-RestartJson $file $op
    Save-RestartJson (Join-Path $Root 'current.json') @{phase='idle';lastOperationId=$id;restoredAt=$op.restoredAt;userSid=$config.userSid}
}
