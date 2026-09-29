param([string]$Directory, [string]$Source, [string]$Endpoint, [string]$BunPath)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $Source 'Pseudoconsole.cs'), (Join-Path $PSScriptRoot 'PtyFixture.cs')
$profileFile = Join-Path $Directory 'profile.ps1'
[IO.File]::WriteAllText($profileFile, "Set-PSReadLineOption -HistorySaveStyle SaveNothing -PredictionSource None`nfunction global:prompt { 'RESIZE_PROMPT> ' }`n")
$arguments = @('-NoLogo', '-NoProfile', '-NoExit', '-File', (Join-Path $Source 'host.ps1'), '-Endpoint', $Endpoint, '-ArchiveRoot', (Join-Path $Directory 'sessions'), '-BunPath', $BunPath, '-ProfileFile', $profileFile)
$terminal = [PtyFixture]::new((Join-Path $PSHOME 'pwsh.exe'), $arguments, $Directory, 128, 35)
function Wait-Text([string]$Needle, [int]$Offset = 0, [int]$Timeout = 12000) {
    $deadline = [Environment]::TickCount64 + $Timeout
    while (-not $terminal.Text.Substring([Math]::Min($Offset, $terminal.Text.Length)).Contains($Needle)) {
        if ($terminal.HasExited -or [Environment]::TickCount64 -gt $deadline) { throw ('No ' + $Needle + ': ' + $terminal.Text.Substring([Math]::Max(0, $terminal.Text.Length - 3000))) }
        Start-Sleep -Milliseconds 20
    }
}
try {
    Wait-Text 'RESIZE_PROMPT> '
    $code = '& ' + "'" + $BunPath.Replace("'", "''") + "' --eval 'console.log(" + '"SIZE="+process.stdout.columns+"x"+process.stdout.rows)' + "'`r"
    $offset = $terminal.Text.Length
    $terminal.Write($code)
    Wait-Text 'SIZE=128x35' $offset
    Wait-Text 'RESIZE_PROMPT> ' $offset
    $terminal.Resize(82, 22)
    Start-Sleep -Milliseconds 400
    $offset = $terminal.Text.Length
    $terminal.Write($code)
    Wait-Text 'SIZE=82x22' $offset
    Wait-Text 'RESIZE_PROMPT> ' $offset
    $offset = $terminal.Text.Length
    $terminal.Write("[Console]::Write('SLEEP'+'STARTED'); Start-Sleep -Seconds 30; [Console]::Write('SHOULD'+'NOTFINISH')`r")
    Wait-Text 'SLEEPSTARTED' $offset
    Start-Sleep -Milliseconds 250
    $offset = $terminal.Text.Length
    # A real Windows Terminal key event, forwarded through an outer and inner pseudoconsole.
    $terminal.Write([char]27 + '[67;46;3;1;8;1_' + [char]27 + '[67;46;3;0;8;1_')
    Wait-Text 'RESIZE_PROMPT> ' $offset 5000
    if ($terminal.Text.Substring($offset).Contains('SHOULDNOTFINISH')) { throw 'Ctrl+C did not cancel execution.' }
    $terminal.Write("exit 19`r")
    if (-not $terminal.Wait(10000) -or $terminal.ExitCode -ne 19) { throw 'Nested host did not preserve the shell exit code.' }
} finally {
    [IO.File]::WriteAllText((Join-Path $Directory 'terminal.txt'), $terminal.Text)
    $terminal.Dispose()
}
'OK'
