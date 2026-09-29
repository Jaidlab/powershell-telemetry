#Requires -Version 7.4
param(
    [Parameter(Mandatory)][string]$Endpoint,
    [string]$ServiceName = 'powershell',
    [string]$ArchiveRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'powershell-telemetry/sessions'),
    [string]$BunPath = 'bun',
    [switch]$NoProfile,
    [string]$ProfileFile
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The terminal recorder currently requires Windows ConPTY.' }
$uri = [Uri]$Endpoint
if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https')) { throw 'The endpoint must be an absolute HTTP(S) URL.' }
if (-not ('PowerShellTelemetry.TerminalHost' -as [type])) {
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'Pseudoconsole.cs'),
        (Join-Path $PSScriptRoot 'TerminalRecorder.cs'),
        (Join-Path $PSScriptRoot 'TerminalHost.cs')
    ) -ErrorAction Stop
}
$directory = Join-Path $ArchiveRoot ([Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($directory)
# Command text and output can contain secrets. Do not inherit broad archive-directory access.
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security.SetOwner($identity)
foreach ($sid in @($identity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
}
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($directory), $security)
$child = ". '" + (Join-Path $PSScriptRoot 'child.ps1').Replace("'", "''") + "'"
if ($NoProfile) { $child += ' -NoProfile' }
if ($ProfileFile) { $child += " -ProfileFile '" + $ProfileFile.Replace("'", "''") + "'" }
$arguments = @('-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child)))
# Synchronize the native process cwd with the caller's PowerShell location.
[Environment]::CurrentDirectory = $PWD.ProviderPath
$exitCode = [PowerShellTelemetry.TerminalHost]::Run($PSScriptRoot, (Join-Path $PSHOME 'pwsh.exe'), $BunPath, $directory, $uri.AbsoluteUri, $ServiceName, $arguments)
# PowerShell can swallow 'exit' while loading a profile or running with -NoExit.
# This process is the dedicated host; terminal, journal and exporter cleanup has already completed.
[Environment]::Exit($exitCode)
