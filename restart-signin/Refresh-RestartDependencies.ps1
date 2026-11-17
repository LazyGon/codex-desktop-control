param([Parameter(Mandatory)][string]$JobPath)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$root='C:\ProgramData\CodexRestartSignIn'
$configPath=Join-Path $root 'config.json'
function Hash([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash}
if((Hash $job.manifest.file) -ne $job.manifest.sha256 -or (Hash $configPath) -ne $job.expectedConfigSha256){throw 'Reviewed manifest or installed configuration changed.'}
$old=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest=Get-Content -LiteralPath $job.manifest.file -Raw -Encoding UTF8 | ConvertFrom-Json
$state=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=Get-Content -LiteralPath 'C:\ProgramData\CodexAdminTerminal\current.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$receipt=Get-Content -LiteralPath ('C:\ProgramData\CodexAdminTerminal\results\'+$job.operationId+'.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($state.phase -ne 'idle' -or $identity.User.Value -ne $old.userSid -or $manifest.userSid -ne $old.userSid -or $manifest.controlRoot -ne $old.controlRoot -or $manifest.nodePath -ne $old.nodePath -or -not ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))){throw 'Exact installed owner and idle sign-in lease required.'}
if($admin.activeOperationId -ne $job.operationId -or $receipt.phase -ne 'running' -or $receipt.pid -ne $PID -or $receipt.task.threadId -ne $job.threadId -or $receipt.task.workspace -ne $job.workspace){throw 'Common admin admission does not match this owner.'}
foreach($file in Get-ChildItem -LiteralPath (Join-Path $root 'operations') -File){
    $operation=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if($operation.phase -notin 'restored-after-logon','restored-canceled','restart-not-accepted'){throw 'An unresolved restart operation exists; never replace its dependency context.'}
}
if((@($old.files.name|Sort-Object) -join ',') -cne (@($manifest.files.name|Sort-Object) -join ',')){throw 'Protected asset set changed.'}
foreach($asset in $old.files){
    $next=@($manifest.files|Where-Object name -eq $asset.name)
    if($next.Count -ne 1 -or $next[0].sha256 -ne $asset.sha256 -or (Hash (Join-Path $root $asset.name)) -ne $asset.sha256){throw 'This operation refreshes dependencies only, not protected executable assets.'}
}
foreach($dependency in $manifest.dependencies){if((Hash $dependency.file) -ne $dependency.sha256){throw 'Reviewed continuation dependency changed.'}}
$backup=Join-Path $root ('dependency-updates\'+([Guid]$job.operationId).ToString())
if(Test-Path -LiteralPath $backup){throw 'Refresh already reserved; inspect instead of replaying.'}
$acl=Get-Acl -LiteralPath $configPath
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $configPath -Destination (Join-Path $backup 'config-before.json')
$old.dependencies=@($manifest.dependencies)
$temporary=Join-Path $root ('config.'+$job.operationId+'.tmp')
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($old|ConvertTo-Json -Depth 16))
$stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
Set-Acl -LiteralPath $temporary -AclObject $acl
Move-Item -LiteralPath $temporary -Destination $configPath -Force
if((Get-Acl -LiteralPath $configPath).Sddl -ne $acl.Sddl){throw 'Installed configuration ACL changed.'}
$actual=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($dependency in $actual.dependencies){if((Hash $dependency.file) -ne $dependency.sha256){throw 'Installed dependency readback failed.'}}
$report=[ordered]@{operationId=$job.operationId;phase='dependencies-refreshed';threadId=$job.threadId;backup=(Join-Path $backup 'config-before.json');manifest=$job.manifest;configSha256=(Hash $configPath);protectedAssetsChanged=$false;aclUnchanged=$true;historicalOperationsChanged=$false;restartIssued=$false;signInSettingChanged=$false;at=[DateTimeOffset]::Now.ToString('o')}
$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $job.receiptPath -Encoding UTF8
$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $backup 'result.json') -Encoding UTF8
$report|ConvertTo-Json -Depth 8
