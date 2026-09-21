#Requires -Version 5.1
<#
    Inspect the GCORES auto-like scheduled task: config, state and recent
    run results. Keep this file ASCII-only (see install-task.ps1).
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'GcoresAutoLike',
    [int]$History = 10
)

$ErrorActionPreference = 'Stop'

# The worker writes UTF-8; without this both the log tail and our own output
# would be mangled by the OEM code page.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Task '$TaskName' is NOT registered." -ForegroundColor Red
    Write-Host "Install it with: npm run gc:task:install"
    exit 1
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host "== Task ==" -ForegroundColor Cyan
Write-Host "  Name            : $($task.TaskName)"
Write-Host "  State           : $($task.State)"
Write-Host "  Logon type      : $($task.Principal.LogonType)"
Write-Host "  Run as          : $($task.Principal.UserId)"
Write-Host "  Execute         : $($task.Actions[0].Execute)"
Write-Host "  Arguments       : $($task.Actions[0].Arguments)"
Write-Host "  Work dir        : $($task.Actions[0].WorkingDirectory)"
Write-Host "  Interval        : $($task.Triggers[0].Repetition.Interval)"
Write-Host "  Multiple inst.  : $($task.Settings.MultipleInstances)"
Write-Host "  Exec time limit : $($task.Settings.ExecutionTimeLimit)"

Write-Host ""
Write-Host "== Last / next run ==" -ForegroundColor Cyan
Write-Host "  Last run time   : $($info.LastRunTime)"
Write-Host "  Last result     : $($info.LastTaskResult)"
Write-Host "  Next run time   : $($info.NextRunTime)"
Write-Host "  Missed runs     : $($info.NumberOfMissedRuns)"

Write-Host ""
Write-Host "== Recent events ==" -ForegroundColor Cyan
try {
    $events = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TaskScheduler/Operational'; StartTime = (Get-Date).AddDays(-3) } -ErrorAction Stop |
        Where-Object { $_.Message -like "*$TaskName*" } |
        Select-Object -First $History
    if (-not $events) {
        Write-Host "  (no matching events in the last 3 days)"
    } else {
        foreach ($event in $events) {
            $firstLine = ($event.Message -split "`r?`n")[0]
            Write-Host ("  {0}  [{1}]  {2}" -f $event.TimeCreated, $event.Id, $firstLine)
        }
    }
} catch {
    Write-Host "  (Task Scheduler operational log is not enabled; skipping)"
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $task.Actions[0].WorkingDirectory)
$logFile = Join-Path $task.Actions[0].WorkingDirectory '.gcores-auto-like\worker.log'
if (Test-Path $logFile) {
    Write-Host ""
    Write-Host "== Worker log tail ==" -ForegroundColor Cyan
    # The worker writes UTF-8; Windows PowerShell 5.1 would otherwise read it as ANSI.
    Get-Content -LiteralPath $logFile -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host ""
    Write-Host "Worker log not found at $logFile"
}
