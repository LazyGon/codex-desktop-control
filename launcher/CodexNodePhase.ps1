function Invoke-CodexNodePhase {
    param([string]$Node, [string]$Root, [string]$Script, [string]$Mode, [string]$Record)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Node
    $info.Arguments = '"{0}" {1}' -f (Join-Path $Root $Script), $Mode
    $info.WorkingDirectory = $Root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errorOutput = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        [IO.File]::WriteAllText((Join-Path $Root "$Record.json"), $output.GetAwaiter().GetResult(), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $Root "$Record.stderr.log"), $errorOutput.GetAwaiter().GetResult(), [Text.UTF8Encoding]::new($false))
        if ($exitCode -ne 0) { throw "Node phase failed with exit $($exitCode): $Script $Mode. Inspect $Record.stderr.log" }
    }
    finally { $process.Dispose() }
}
