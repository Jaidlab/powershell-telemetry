param([string]$Directory, [string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $Source 'TerminalRecorder.cs')
$display = [IO.MemoryStream]::new()
$recorder = [PowerShellTelemetry.TerminalRecorder]::new($Directory, 'test-token', [Action[byte[]]]{ param($bytes) $display.Write($bytes, 0, $bytes.Length) })
function Frame($value) {
    $json = $value | ConvertTo-Json -Compress -Depth 10
    [Text.Encoding]::ASCII.GetBytes([char]27 + ']633;PST;test-token;' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) + [char]7)
}
$before = [Text.Encoding]::UTF8.GetBytes('unsubmitted-private-text')
$recorder.Feed($before)
$id = [Guid]::NewGuid().ToString('N')
$start = Frame @{type = 'start'; id = $id; command = 'recorder-test'; pwd = $PWD.Path; time = 1000}
foreach ($byte in $start) { $recorder.Feed([byte[]]@($byte)) }
$sample = [Text.Encoding]::UTF8.GetBytes('one' + [char]27 + '[2m↵' + [char]27 + '[22m' + [char]27 + ']8;;https://example.invalid/tool?tool_call=32' + [char]7 + 'link' + [char]27 + ']8;;' + [char]7 + "🦄é`r`n`tend")
foreach ($byte in $sample) { $recorder.Feed([byte[]]@($byte)) }
$large = [Text.Encoding]::UTF8.GetBytes('🦄' * 25000)
$recorder.Feed($large)
$complete = Frame @{type = 'complete'; id = $id; time = 1200; success = $true; resultKnown = $true; resultCode = 0; outcome = 'success'}
foreach ($byte in $complete) { $recorder.Feed([byte[]]@($byte)) }
$after = [Text.Encoding]::UTF8.GetBytes('prompt-not-output')
$recorder.Feed($after)
$recorder.EndSession(0)
$recorder.Dispose()
$expected = $before + $sample + $large + $after
if ([Convert]::ToBase64String($display.ToArray()) -ne [Convert]::ToBase64String($expected)) { throw 'Terminal bytes changed or private markers leaked.' }
[IO.File]::WriteAllBytes((Join-Path $Directory 'expected.bin'), ($sample + $large))
$buffer = [PowerShellTelemetry.BoundedText]::new()
$buffer.Append(('x' * 8191) + '🦄' + ('y' * 8189))
if ($buffer.Truncated -or $buffer.ToString().Contains([char]0xFFFD)) { throw 'A Unicode boundary changed an untruncated preview.' }
$buffer.Append('🦄' * 10000)
if (-not $buffer.Truncated -or $buffer.CapturedBytes -gt 16384 -or $buffer.ToString().Contains([char]0xFFFD)) { throw 'A bounded preview split Unicode or exceeded its byte budget.' }
'OK'

$failed = [PowerShellTelemetry.TerminalRecorder]::new((Join-Path $Directory 'failed'), 'test-token', [Action[byte[]]]{ param($bytes) $display.Write($bytes, 0, $bytes.Length) })
$failed.Feed((Frame @{type = 'fault'; message = 'Controlled observer failure'}))
$failed.Feed([Text.Encoding]::UTF8.GetBytes('Output still passes through'))
if (-not $failed.Error) { throw 'Observer failure was not surfaced.' }
$failed.EndSession(0)
$failed.Dispose()
if (-not [Text.Encoding]::UTF8.GetString($display.ToArray()).Contains('Output still passes through')) { throw 'Observer failure stopped terminal output.' }
