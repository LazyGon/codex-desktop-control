function Get-CodexDesktopPackageInfo {
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()]
        [object[]]$Packages,

        [switch]$RequireBundledRuntime
    )

    if (-not $PSBoundParameters.ContainsKey('Packages')) {
        $Packages = @(Get-AppxPackage -Name 'OpenAI.Codex')
    }

    $package = @($Packages) |
        Where-Object { $null -ne $_ } |
        Sort-Object { [version]$_.Version } -Descending |
        Select-Object -First 1
    if ($null -eq $package) {
        throw 'OpenAI.Codex is not installed for the current Windows user.'
    }

    $installLocation = [IO.Path]::GetFullPath([string]$package.InstallLocation)
    $desktopExecutable = [IO.Path]::GetFullPath((Join-Path $installLocation 'app\ChatGPT.exe'))
    $bundledServerExecutable = [IO.Path]::GetFullPath((Join-Path $installLocation 'app\resources\codex.exe'))
    $bundledCodeModeHostExecutable = [IO.Path]::GetFullPath((Join-Path $installLocation 'app\resources\codex-code-mode-host.exe'))
    $bundledCommandRunnerExecutable = [IO.Path]::GetFullPath((Join-Path $installLocation 'app\resources\codex-command-runner.exe'))
    $bundledSandboxServiceExecutable = [IO.Path]::GetFullPath((Join-Path $installLocation 'app\resources\codex-windows-sandbox-service.exe'))
    $bundledSandboxSetupExecutable = [IO.Path]::GetFullPath((Join-Path $installLocation 'app\resources\codex-windows-sandbox-setup.exe'))

    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
        throw "Desktop executable was not found: $desktopExecutable"
    }
    if ($RequireBundledRuntime -and -not (Test-Path -LiteralPath $bundledServerExecutable -PathType Leaf)) {
        throw "Bundled app-server executable was not found: $bundledServerExecutable"
    }
    if ($RequireBundledRuntime -and -not (Test-Path -LiteralPath $bundledCodeModeHostExecutable -PathType Leaf)) {
        throw "Bundled Code Mode host executable was not found: $bundledCodeModeHostExecutable"
    }
    foreach ($companion in @(
        $bundledCommandRunnerExecutable,
        $bundledSandboxServiceExecutable,
        $bundledSandboxSetupExecutable
    )) {
        if ($RequireBundledRuntime -and -not (Test-Path -LiteralPath $companion -PathType Leaf)) {
            throw "Bundled app-server companion executable was not found: $companion"
        }
    }

    [pscustomobject]@{
        Version = ([version]$package.Version).ToString()
        PackageFamilyName = [string]$package.PackageFamilyName
        ApplicationUserModelId = "$($package.PackageFamilyName)!App"
        InstallLocation = $installLocation
        DesktopExecutable = $desktopExecutable
        BundledServerExecutable = $bundledServerExecutable
        BundledCodeModeHostExecutable = $bundledCodeModeHostExecutable
        BundledCommandRunnerExecutable = $bundledCommandRunnerExecutable
        BundledSandboxServiceExecutable = $bundledSandboxServiceExecutable
        BundledSandboxSetupExecutable = $bundledSandboxSetupExecutable
    }
}

function Get-CodexDesktopPackageReplacement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CurrentVersion,

        [Parameter(Mandatory)]
        [string]$CurrentDesktopExecutable,

        [AllowEmptyCollection()]
        [object[]]$Packages
    )

    $parameters = @{}
    if ($PSBoundParameters.ContainsKey('Packages')) {
        $parameters.Packages = $Packages
    }
    $candidate = Get-CodexDesktopPackageInfo @parameters
    if (
        $candidate.Version -eq $CurrentVersion -and
        [string]::Equals(
            $candidate.DesktopExecutable,
            [IO.Path]::GetFullPath($CurrentDesktopExecutable),
            [StringComparison]::OrdinalIgnoreCase)
    ) {
        return $null
    }

    $candidate
}
