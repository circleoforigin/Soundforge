#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$Destination = 'C:\SACscapeBridge',
    [string]$TaskName = 'SACscape Sonos Bridge'
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = $PSScriptRoot
$node = Get-Command node.exe -ErrorAction Stop
$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)

New-Item -ItemType Directory -Path $resolvedDestination -Force | Out-Null
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# Copy an explicit allow-list. An existing .env.local in the destination is never read or touched.
foreach ($fileName in @('bridge.cjs', 'bridge.cjs.LEGAL.txt', 'package.json', 'README.md', 'Install-SACscapeSonosBridge.ps1', 'Manage-SACscapeSonosBridge.ps1')) {
    $sourcePath = Join-Path $sourceDirectory $fileName
    $destinationPath = Join-Path $resolvedDestination $fileName
    if ((Test-Path -LiteralPath $sourcePath) -and ([System.IO.Path]::GetFullPath($sourcePath) -ne [System.IO.Path]::GetFullPath($destinationPath))) {
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    }
}

$action = New-ScheduledTaskAction `
    -Execute $node.Source `
    -Argument 'bridge.cjs' `
    -WorkingDirectory $resolvedDestination
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Minimal SACscape Sonos OAuth and Cloud bridge.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started '$TaskName' from $resolvedDestination."
Write-Host "Verify locally with: Invoke-RestMethod http://localhost:3001/api/health"
