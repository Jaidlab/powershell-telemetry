#Requires -Version 7.4
param(
    [Parameter(Mandatory)][string]$Endpoint,
    [string]$ServiceName = 'powershell',
    [string]$ArchiveRoot,
    [string]$BunPath = 'bun'
)
# A nested shell remains part of the enclosing command's terminal recording.
if ($env:POWERSHELL_TELEMETRY_SESSION) { return }
if (-not $IsWindows -or $Host.Name -ne 'ConsoleHost' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { return }
# Profile installation instruments interactive startup, never unattended -Command/-File invocations.
$__pst_args = [Environment]::GetCommandLineArgs() | Select-Object -Skip 1
foreach ($__pst_arg in $__pst_args) {
    if ($__pst_arg -match '^-(c|co|com|comm|comma|comman|command|e|ec|enc|encodedcommand|f|fi|fil|file|noni|noninteractive)$') { return }
}
$__pst_options = @{ Endpoint = $Endpoint; ServiceName = $ServiceName; BunPath = $BunPath }
if ($ArchiveRoot) { $__pst_options.ArchiveRoot = $ArchiveRoot }
. (Join-Path $PSScriptRoot 'host.ps1') @__pst_options
