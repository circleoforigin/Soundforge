[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Restart', 'Status')]
    [string]$Action = 'Status',
    [string]$TaskName = 'SACscape Sonos Bridge'
)

$ErrorActionPreference = 'Stop'
switch ($Action) {
    'Start' { Start-ScheduledTask -TaskName $TaskName }
    'Stop' { Stop-ScheduledTask -TaskName $TaskName }
    'Restart' {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $TaskName
    }
    'Status' {
        Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
        Get-ScheduledTaskInfo -TaskName $TaskName |
            Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns
    }
}
