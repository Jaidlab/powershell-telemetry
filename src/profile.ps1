#Requires -Version 7.4
# Installed by child.ps1 after the user's profiles have finished configuring the shell.
if ($ExecutionContext.SessionState.PSVariable.GetValue('PowerShellTelemetry')) { return }
if (-not $env:POWERSHELL_TELEMETRY_SESSION -or -not $env:POWERSHELL_TELEMETRY_TOKEN) {
    Write-Warning 'Terminal telemetry requires its recorder. Open a new installed terminal or run bun run start.'
    return
}
if (-not ('PowerShellTelemetry.Capture' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'Capture.cs') -ErrorAction Stop }
[PowerShellTelemetry.Capture]::Configure($env:POWERSHELL_TELEMETRY_SESSION, $env:POWERSHELL_TELEMETRY_TOKEN)

$global:PowerShellTelemetry = @{
    Enabled = $true
    SessionPath = $env:POWERSHELL_TELEMETRY_SESSION
    OriginalReadLine = $function:PSConsoleHostReadLine
    OriginalPrompt = $function:prompt
    OriginalLookup = $ExecutionContext.InvokeCommand.PostCommandLookupAction
}

function global:Start-PowerShellTelemetryCommand {
    param([string]$Command)
    if (-not $global:PowerShellTelemetry.Enabled -or [string]::IsNullOrWhiteSpace($Command)) { return }
    $id = [PowerShellTelemetry.Capture]::Begin($global:Error)
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Command, [ref]$tokens, [ref]$parseErrors)
    # This only annotates a potential shell exit. It never rewrites an expression or executes it twice.
    $exits = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.ExitStatementAst] }, $false)
    $message = @{
        type = 'start'
        id = $id
        command = $Command
        pwd = $PWD.Path
        time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        shellPid = $PID
        shellVersion = $PSVersionTable.PSVersion.ToString()
        exitsShell = [bool]$exits.Count
    }
    [PowerShellTelemetry.Capture]::Send(($message | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 8))
}

function global:Complete-PowerShellTelemetryCommand {
    param([bool]$Success, $NativeExitCode)
    $id = [PowerShellTelemetry.Capture]::ActiveId
    if (-not $id) { return }
    try {
        $lookups = [PowerShellTelemetry.Capture]::NativeLookups
        $code = if ($Success) { 0 } elseif ($lookups.Count -and $null -ne $NativeExitCode -and [int]$NativeExitCode -ne 0) { [int]$NativeExitCode } else { 1 }
        $errors = @([PowerShellTelemetry.Capture]::NewErrors($global:Error) | Microsoft.PowerShell.Core\ForEach-Object {
            @{
                message = $_.Exception.ToString()
                errorId = $_.FullyQualifiedErrorId
                category = $_.CategoryInfo.ToString()
                position = $_.InvocationInfo.PositionMessage
                scriptStackTrace = $_.ScriptStackTrace
                details = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $null }
            }
        })
        $message = @{
            type = 'complete'
            id = $id
            time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            resultKnown = $true
            success = $Success
            resultCode = $code
            outcome = if ($Success) { 'success' } else { 'error' }
            nativeExitCode = $NativeExitCode
            nativeLookups = @($lookups)
            errors = $errors
        }
        [PowerShellTelemetry.Capture]::Send(($message | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 12))
    } finally { [PowerShellTelemetry.Capture]::End() }
}

$ExecutionContext.InvokeCommand.PostCommandLookupAction = {
    param($sender, $eventArgs)
    if ($global:PowerShellTelemetry.OriginalLookup) { $global:PowerShellTelemetry.OriginalLookup.Invoke($sender, $eventArgs) }
    if ([PowerShellTelemetry.Capture]::ActiveId -and $eventArgs.Command -is [System.Management.Automation.ApplicationInfo]) {
        [PowerShellTelemetry.Capture]::NativeLookup($eventArgs.Command.Path)
    }
}

function global:PSConsoleHostReadLine {
    $previousSuccess = $?
    if ($global:PowerShellTelemetry.OriginalReadLine) {
        if (-not $previousSuccess) { Microsoft.PowerShell.Utility\Write-Error 'The previous command failed.' -ErrorAction Ignore }
        $line = & $global:PowerShellTelemetry.OriginalReadLine
    } else {
        $line = [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext, $previousSuccess)
    }
    try { Start-PowerShellTelemetryCommand $line }
    catch { [PowerShellTelemetry.Capture]::Fail($_.Exception.Message) }
    # Return the exact submitted source. No pipeline, scope wrapper, exit rewrite or history repair.
    return $line
}

function global:prompt {
    $previousSuccess = $?
    $nativeExitCode = $ExecutionContext.SessionState.PSVariable.GetValue('LASTEXITCODE')
    try { Complete-PowerShellTelemetryCommand -Success $previousSuccess -NativeExitCode $nativeExitCode }
    catch { [PowerShellTelemetry.Capture]::Fail($_.Exception.Message) }
    if (-not $previousSuccess) { Microsoft.PowerShell.Utility\Write-Error 'The previous command failed.' -ErrorAction Ignore }
    & $global:PowerShellTelemetry.OriginalPrompt
}

function global:Get-PowerShellTelemetryStatus {
    $directory = $global:PowerShellTelemetry.SessionPath
    $delivery = $null
    $capture = $null
    try {
        $delivery = [PowerShellTelemetry.Capture]::ReadStatus((Join-Path $directory 'status.json')) | Microsoft.PowerShell.Utility\ConvertFrom-Json
    } catch [IO.FileNotFoundException] { }
    try {
        $capture = [PowerShellTelemetry.Capture]::ReadStatus((Join-Path $directory 'capture.json')) | Microsoft.PowerShell.Utility\ConvertFrom-Json
    } catch [IO.FileNotFoundException] { }
    [pscustomobject]@{
        Enabled = $global:PowerShellTelemetry.Enabled
        Capture = 'terminal-vt'
        ArchivePath = $directory
        LifecycleError = [PowerShellTelemetry.Capture]::LastError
        Recorder = $capture
        Delivery = $delivery
        DeliveryStale = -not $delivery -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $delivery.time -gt 5000
    }
}

function global:Sync-PowerShellTelemetry {
    param([ValidateRange(1, 600000)][int]$Timeout = 10000)
    [PowerShellTelemetry.Capture]::Sync($Timeout)
}

[PowerShellTelemetry.Capture]::Send((@{type = 'ready'; shellPid = $PID; shellVersion = $PSVersionTable.PSVersion.ToString()} | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress))
