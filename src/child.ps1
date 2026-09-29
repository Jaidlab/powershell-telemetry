#Requires -Version 7.4
param([switch]$NoProfile, [string]$ProfileFile)
if (-not $env:POWERSHELL_TELEMETRY_SESSION) { throw 'This entrypoint must be started by the terminal recorder.' }
Add-Type -Path (Join-Path $PSScriptRoot 'Capture.cs') -ErrorAction Stop
[PowerShellTelemetry.Capture]::InitializeConsole()
Import-Module PSReadLine -ErrorAction Stop
if ($ProfileFile) {
    . $ProfileFile
} elseif (-not $NoProfile) {
    foreach ($__pst_profile in @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)) {
        if (Test-Path -LiteralPath $__pst_profile) { . $__pst_profile }
    }
    Remove-Variable __pst_profile -ErrorAction Ignore
}
. (Join-Path $PSScriptRoot 'profile.ps1')
