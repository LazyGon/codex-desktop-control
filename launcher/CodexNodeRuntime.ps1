function Get-CodexNodeExecutable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [AllowEmptyString()][string]$SearchPath = $env:PATH
    )
    foreach ($directory in ($SearchPath -split [IO.Path]::PathSeparator)) {
        $directory = $directory.Trim().Trim('"')
        if (-not $directory) { continue }
        try { $candidate = Join-Path $directory 'node.exe' } catch { continue }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    $recordPath = Join-Path $StateRoot 'node-runtime.json'
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        $candidate = [string]$record.nodeExecutable
        if ($record.schemaVersion -ne 1 -or -not [IO.Path]::IsPathRooted($candidate) -or
            [IO.Path]::GetFileName($candidate) -ine 'node.exe' -or
            -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw 'The recorded Node.js runtime is invalid or missing. Rerun the launcher installer with Node.js available.'
        }
        return [IO.Path]::GetFullPath($candidate)
    }
    throw 'Node.js is not on PATH and no installed runtime was recorded. Rerun the launcher installer with Node.js 22 or newer available.'
}

function Initialize-CodexNodeRuntime {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)
    $nodeExecutable = Get-CodexNodeExecutable -StateRoot $StateRoot
    $nodeVersion = (& $nodeExecutable --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Codex Desktop Control requires Node.js 22 or newer.'
    }
    $nodeDirectory = Split-Path -Parent $nodeExecutable
    $env:PATH = $nodeDirectory + [IO.Path]::PathSeparator + $env:PATH
    return $nodeExecutable
}
