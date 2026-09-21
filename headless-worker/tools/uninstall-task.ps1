#Requires -Version 5.1
<#
    Remove the GCORES auto-like scheduled task.
    Keep this file ASCII-only (see install-task.ps1 for the reason).
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'GcoresAutoLike'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Task '$TaskName' does not exist." -ForegroundColor Yellow
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Task '$TaskName' removed." -ForegroundColor Green
