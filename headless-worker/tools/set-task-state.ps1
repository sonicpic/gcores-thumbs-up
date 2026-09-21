#Requires -Version 5.1
<#
    Enable or disable the GCORES auto-like scheduled task.

    "stop"  = Disable-ScheduledTask (+ kill any in-flight run). The task stops
              firing but stays registered, so it can be re-enabled any time.
    "start" = Enable-ScheduledTask. The task resumes its 30-minute cadence.

    This is the control path behind `node src/cli.js task start|stop` and the
    control panel buttons. Keep this file ASCII-only (see install-task.ps1).
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'GcoresAutoLike',
    [Parameter(Mandatory = $true)]
    [ValidateSet('Enable', 'Disable')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Task '$TaskName' is NOT registered." -ForegroundColor Red
    Write-Host "Install it with: npm run gc:task:install"
    exit 1
}

if ($Action -eq 'Disable') {
    # Kill an in-flight run (if any) first, then block future triggers.
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Task '$TaskName' has been STOPPED (disabled)." -ForegroundColor Yellow
    Write-Host "It will not fire again until you start it:  npm run gc:task:start"
} else {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Task '$TaskName' has been STARTED (enabled)." -ForegroundColor Green
}

$t = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ""
Write-Host "  State    : $($t.State)"
Write-Host "  Next run : $($info.NextRunTime)"
