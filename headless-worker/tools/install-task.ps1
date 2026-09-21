#Requires -Version 5.1
<#
    Register the GCORES auto-like worker as a Windows Scheduled Task.

    This is the core of the "no RDP required" operating model: there is no
    resident daemon process. Task Scheduler wakes a short-lived worker every
    N minutes; the worker finishes and exits. A crashed or killed run cannot
    poison the next one, and neither RDP disconnect, logoff nor reboot can
    stop the schedule.

    NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses .ps1 as
    ANSI unless a BOM is present, which would garble non-ASCII text.
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'GcoresAutoLike',
    [int]$IntervalMinutes = 30,
    [string]$ProjectRoot = '',
    [string]$NodePath = '',
    [switch]$RunWhenLoggedOff,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$CliPath = Join-Path $ProjectRoot 'src\cli.js'

if (-not (Test-Path $CliPath)) {
    throw "cli.js not found: $CliPath"
}

function Get-NodeMajor([string]$path) {
    try {
        $raw = (& $path -v 2>$null) -join ''
        if ($raw -match 'v(\d+)\.') { return [int]$Matches[1] }
    } catch { }
    return 0
}

# Prefer a stable, system-wide Node over any machine-specific install (for
# example an IDE-managed runtime): the launcher resolves Node at run time and
# must keep working after unrelated tooling is updated or removed.
# -NodePath is only the last-resort hint.
$pathNode = (Get-Command node.exe -ErrorAction SilentlyContinue)
$candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
if ($pathNode) { $candidates += $pathNode.Source }
if ($NodePath) { $candidates += $NodePath }

$NodePath = ''
foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    if (-not (Test-Path $candidate)) { continue }
    if ((Get-NodeMajor $candidate) -lt 18) { continue }
    $NodePath = (Resolve-Path $candidate).Path
    break
}
if (-not $NodePath) {
    throw "No usable Node.js (>=18) found. Install Node.js, or pass -NodePath explicitly."
}

$Launcher = Join-Path $ProjectRoot 'tools\gc.cmd'
if (-not (Test-Path $Launcher)) {
    throw "Launcher not found: $Launcher"
}
# Recorded as a last-resort hint for the launcher; gc.cmd prefers system paths.
Set-Content -Path (Join-Path $ProjectRoot 'tools\node-path.txt') -Value $NodePath -Encoding ASCII

Write-Host "Project root : $ProjectRoot"
Write-Host "Launcher     : $Launcher"
Write-Host "Node (hint)  : $NodePath"
Write-Host "Task name    : $TaskName"
Write-Host "Interval     : $IntervalMinutes minutes"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    Write-Host "Task '$TaskName' already exists. Re-run with --force to replace it." -ForegroundColor Yellow
    Write-Host "Current state: $($existing.State)"
    exit 2
}

# Route the task through cmd.exe + gc.cmd so the actual Node runtime is
# resolved at *run* time. cmd.exe lives at a fixed OS path, so the task
# survives Node upgrades and the removal of whichever tool installed Node.
$CmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
$argument = '/c ""{0}" run --quiet"' -f $Launcher
$action = New-ScheduledTaskAction -Execute $CmdExe -Argument $argument -WorkingDirectory $ProjectRoot

# A wall-clock based repetition trigger: it keeps firing regardless of logon
# state, and StartWhenAvailable below catches up on runs missed while the
# machine was powered off.
$interval = New-TimeSpan -Minutes $IntervalMinutes
$duration = New-TimeSpan -Days 3650
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) -RepetitionInterval $interval -RepetitionDuration $duration

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -Compatibility Win8

if ($RunWhenLoggedOff) {
    Write-Host "Principal    : S4U (runs whether or not the user is logged on)"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

    # Pre-flight: prove S4U is permitted *before* replacing anything, so a
    # permission failure cannot cost the user their working task.
    $probeName = "$TaskName`__preflight"
    try {
        Register-ScheduledTask -TaskName $probeName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -ErrorAction Stop | Out-Null
        Unregister-ScheduledTask -TaskName $probeName -Confirm:$false
    } catch {
        Write-Host ""
        Write-Host "S4U pre-flight failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "S4U needs elevation ('Access denied' means this shell is not running as" -ForegroundColor Yellow
        Write-Host "administrator). Re-run from an elevated PowerShell, or drop --s4u:" -ForegroundColor Yellow
        Write-Host "the default Interactive mode keeps working across RDP disconnects and" -ForegroundColor Yellow
        Write-Host "does not require administrator rights." -ForegroundColor Yellow
        if ($existing) {
            Write-Host ""
            Write-Host "Your existing task was not modified." -ForegroundColor Yellow
        }
        exit 1
    }
} else {
    Write-Host "Principal    : Interactive (runs while the user has a session; RDP disconnect is fine)"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'GCORES headless auto-like worker (short-lived run, driven by Task Scheduler)' -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ""
Write-Host "Registered successfully." -ForegroundColor Green
Write-Host "  State       : $($task.State)"
Write-Host "  Next run    : $((Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime)"
Write-Host "  Log file    : $(Join-Path $ProjectRoot '.gcores-auto-like\worker.log')"
Write-Host ""
Write-Host "Run it once now:  Start-ScheduledTask -TaskName '$TaskName'"
