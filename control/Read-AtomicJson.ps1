function Open-AtomicJsonReadStream {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)
    # Read access only. Sharing allows an atomic publisher to replace the path
    # while this handle retains its complete, original file generation.
    return [IO.File]::Open($LiteralPath, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
}

function Read-AtomicJsonSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)
    $stream = $null
    $reader = $null
    try {
        $stream = Open-AtomicJsonReadStream -LiteralPath $LiteralPath
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $false)
        $text = $reader.ReadToEnd().TrimStart([char]0xfeff)
        $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop
        return [pscustomobject]@{ phase = 'ready'; value = $value; win32Error = $null }
    } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $win32Error = $failure.HResult -band 0xffff
        if ($failure -is [IO.IOException] -and $win32Error -in @(32, 33)) {
            # Retry the read on the next notification, never any external write.
            return [pscustomobject]@{ phase = 'temporarily-unavailable'; value = $null; win32Error = $win32Error }
        }
        throw
    } finally {
        if ($reader) { $reader.Dispose() }
        elseif ($stream) { $stream.Dispose() }
    }
}
