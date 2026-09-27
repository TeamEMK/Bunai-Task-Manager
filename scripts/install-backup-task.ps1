# Registers the every-third-day database backup with Windows Task Scheduler.
# Run once:
#     powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
#
# To stop it later:
#     Unregister-ScheduledTask -TaskName 'Bunai database backup' -Confirm:$false
#
# ASCII only, for the same reason backup-db.ps1 is: PowerShell 5.1 reads a .ps1
# as ANSI unless it carries a BOM.

[CmdletBinding()]
param(
  [string] $TaskName = 'Bunai database backup',
  # Time of day to run. Evening by default, when the machine is likely on but
  # nobody is waiting on it.
  [string] $At = '19:00',
  [int]    $EveryDays = 3,
  [int]    $Keep = 12,
  [string] $Destination = '',
  # Which database to copy. Blank means the app's own .env, which is the local
  # MySQL. Point it at .env.production.local to register the live one instead.
  [string] $EnvFile = '',
  # Dumping the local database takes seconds. The live one comes over Railway's
  # public proxy and took 21 minutes on first run, so 30 would leave it being
  # killed part way through the moment the data grows a little.
  [int]    $TimeLimitMinutes = 30
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$backup = Join-Path $scriptDir 'backup-db.ps1'
if (-not (Test-Path $backup)) { throw "backup-db.ps1 is not next to this script (looked in $scriptDir)." }

$argLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Keep {1}' -f $backup, $Keep
if ($Destination) { $argLine += ' -Destination "{0}"' -f $Destination }
if ($EnvFile) {
  if (-not (Test-Path $EnvFile)) { throw "EnvFile not found: $EnvFile" }
  $argLine += ' -EnvFile "{0}"' -f (Resolve-Path $EnvFile).Path
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory (Split-Path $scriptDir -Parent)
$trigger = New-ScheduledTaskTrigger -Daily -DaysInterval $EveryDays -At $At

# StartWhenAvailable matters on a laptop: if the machine is off at 19:00 the run
# is not simply skipped for three more days, it happens at the next opportunity.
# DontStopIfGoingOnBatteries for the same reason.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeLimitMinutes) `
  -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  Replaced the existing task."
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Takes a compressed copy of the Bunai MySQL database to the Desktop every $EveryDays days, keeping the newest $Keep." | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ""
Write-Host ("  Task      : {0}" -f $task.TaskName)
Write-Host ("  Runs      : every {0} days at {1}" -f $EveryDays, $At)
Write-Host ("  Next run  : {0}" -f $info.NextRunTime)
Write-Host ("  Command   : powershell.exe {0}" -f $argLine)
Write-Host ""
Write-Host "  Run it now to check:  Start-ScheduledTask -TaskName '$TaskName'"
