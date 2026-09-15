# Takes a full copy of the Bunai database and leaves it on the Desktop.
#
# One compressed .sql per run, named by the moment it was taken, with the oldest
# pruned once there are more than -Keep. Everything the app holds lives in MySQL
# (orders, returns, stock, FMS configuration, users, tasks), so the database IS
# the backup; sheets stay in Google and uploaded documents stay in Drive.
#
# Deliberately ASCII only. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it
# carries a BOM, so a stray em-dash in a comment is a parse error, not a typo.
#
# Run it by hand any time:
#     powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
# Or install the every-third-day schedule once:
#     powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1

[CmdletBinding()]
param(
  # Where the copies go. Resolved through the shell so a Desktop redirected into
  # OneDrive still lands in the right place.
  [string] $Destination = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Bunai Backups'),
  # How many to keep. At one every three days, 12 is about five weeks.
  [int]    $Keep = 12,
  # Left blank so it can be worked out below: $PSScriptRoot is not yet populated
  # while parameter defaults are being evaluated.
  [string] $EnvFile = '',
  [string] $MysqlDump = ''
)

$ErrorActionPreference = 'Stop'
$started = Get-Date

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot  = Split-Path -Parent $scriptDir
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot '.env' }

function Write-Log {
  param([string] $Message, [string] $Level = 'info')
  $line = '{0}  {1,-5}  {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  if ($script:LogFile) { Add-Content -Path $script:LogFile -Value $line -Encoding utf8 }
}

# --- The database to copy -----------------------------------------------
# Read from the app's own .env, so the backup can never drift onto a different
# database than the one the app is actually using.
function Read-EnvFile {
  param([string] $Path)
  if (-not (Test-Path $Path)) {
    throw "No .env at $Path, so there is no way to tell which database to back up."
  }
  $map = @{}
  foreach ($line in Get-Content $Path -Encoding utf8) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $key = $t.Substring(0, $i).Trim()
    $val = $t.Substring($i + 1).Trim()
    if ($val.Length -ge 2) {
      if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
        $val = $val.Substring(1, $val.Length - 2)
      }
    }
    $map[$key] = $val
  }
  return $map
}

function Find-MysqlDump {
  param([string] $Preferred)
  if ($Preferred -and (Test-Path $Preferred)) { return $Preferred }
  $onPath = Get-Command mysqldump.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $guesses = @(
    'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe',
    'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe',
    'C:\Program Files\MariaDB 11.4\bin\mysqldump.exe',
    'C:\xampp\mysql\bin\mysqldump.exe',
    'C:\laragon\bin\mysql\mysql-8.0.30-winx64\bin\mysqldump.exe'
  )
  foreach ($g in $guesses) { if (Test-Path $g) { return $g } }
  throw 'mysqldump.exe not found. Pass -MysqlDump "C:\path\to\mysqldump.exe".'
}

try {
  if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
  $script:LogFile = Join-Path $Destination 'backup-log.txt'

  # A backup nobody knows how to restore is half a backup, and the day it is
  # needed is the worst day to work it out. The note sits with the files.
  $howTo = Join-Path $Destination 'HOW-TO-RESTORE.txt'
  if (-not (Test-Path $howTo)) {
    $notice = @(
      'RESTORING A BUNAI BACKUP',
      '',
      'Each bunai_<date>_<time>.zip holds one .sql file: the whole database as it',
      'stood at that moment - every table, its structure and its rows.',
      '',
      '1. Unzip the one you want. You get bunai_<date>_<time>.sql.',
      '',
      '2. Make sure the target database exists and is EMPTY. Restoring on top of',
      '   live data does not merge, it replaces table by table, and anything',
      '   added since the backup is gone.',
      '',
      '     mysql -u root -p -e "DROP DATABASE IF EXISTS bunai_restore; CREATE DATABASE bunai_restore CHARACTER SET utf8mb4;"',
      '',
      '3. Load it in:',
      '',
      '     mysql -u root -p bunai_restore < bunai_2026-01-01_1900.sql',
      '',
      '   (mysql.exe usually lives in C:\Program Files\MySQL\MySQL Server 8.0\bin)',
      '',
      '4. Look at it before pointing the app at it - restore into bunai_restore',
      '   first, check the row counts, and only then change DB_NAME in .env.',
      '',
      'WHAT IS NOT IN HERE',
      '  - Google Sheets. They live in Google and are not copied.',
      '  - Files uploaded against a PO or an FMS step. They live in Google Drive.',
      '  - .env and credentials.json. Those are secrets and are deliberately left',
      '    out of a folder that sits on the Desktop.'
    ) -join "`r`n"
    Set-Content -Path $howTo -Value $notice -Encoding ascii
  }

  $cfg = Read-EnvFile -Path $EnvFile
  $dbHost = if ($cfg['DB_HOST']) { $cfg['DB_HOST'] } else { '127.0.0.1' }
  $dbPort = if ($cfg['DB_PORT']) { $cfg['DB_PORT'] } else { '3306' }
  $dbUser = $cfg['DB_USER']
  $dbPass = $cfg['DB_PASSWORD']
  $dbName = $cfg['DB_NAME']
  if (-not $dbName -or -not $dbUser) { throw 'DB_NAME or DB_USER is missing from .env.' }

  $dumpExe = Find-MysqlDump -Preferred $MysqlDump
  Write-Log ("Backing up {0} from {1}:{2} using {3}" -f $dbName, $dbHost, $dbPort, (Split-Path $dumpExe -Leaf))

  $stamp   = Get-Date -Format 'yyyy-MM-dd_HHmm'
  $sqlPath = Join-Path $Destination "bunai_$stamp.sql"
  $zipPath = Join-Path $Destination "bunai_$stamp.zip"

  # The password goes in a file rather than on the command line, where every
  # other process on the machine could read it out of the argument list.
  $credFile = Join-Path ([System.IO.Path]::GetTempPath()) ("bunai-dump-" + [guid]::NewGuid().ToString('N') + '.cnf')
  $cred = "[client]`r`nhost=$dbHost`r`nport=$dbPort`r`nuser=$dbUser`r`npassword=$dbPass`r`n"
  Set-Content -Path $credFile -Value $cred -Encoding ascii

  try {
    # --single-transaction takes a consistent copy of InnoDB tables without
    # locking anyone out, so this is safe to run while the app is serving.
    $dumpArgs = @(
      ('--defaults-extra-file=' + $credFile),
      '--single-transaction',
      # mysqldump 8 asks the server for tablespace information, which needs the
      # PROCESS privilege the app's own user has no business holding. The data
      # does not need it, so don't ask and don't print the refusal.
      '--no-tablespaces',
      '--routines',
      '--triggers',
      '--default-character-set=utf8mb4',
      '--result-file',
      $sqlPath,
      $dbName
    )
    & $dumpExe @dumpArgs
    if ($LASTEXITCODE -ne 0) { throw "mysqldump exited with code $LASTEXITCODE" }
  }
  finally {
    Remove-Item $credFile -Force -ErrorAction SilentlyContinue
  }

  if (-not (Test-Path $sqlPath)) { throw 'mysqldump reported success but wrote no file.' }
  $rawBytes = (Get-Item $sqlPath).Length
  $rawMb = [math]::Round($rawBytes / 1MB, 2)
  # A dump that is suspiciously small usually means a permissions problem rather
  # than an empty database, and silently keeping it would be the worst outcome.
  if ($rawBytes -lt 10KB) {
    Remove-Item $sqlPath -Force -ErrorAction SilentlyContinue
    throw "The dump is only $rawMb MB, which is too small to be the whole database. Nothing was kept."
  }

  Compress-Archive -Path $sqlPath -DestinationPath $zipPath -CompressionLevel Optimal -Force
  Remove-Item $sqlPath -Force
  $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
  Write-Log ("Wrote {0} - {1} MB compressed, from {2} MB of SQL" -f (Split-Path $zipPath -Leaf), $zipMb, $rawMb)

  # --- Prune --------------------------------------------------------------
  $all = @(Get-ChildItem -Path $Destination -Filter 'bunai_*.zip' | Sort-Object LastWriteTime -Descending)
  if ($all.Count -gt $Keep) {
    foreach ($old in $all[$Keep..($all.Count - 1)]) {
      Remove-Item $old.FullName -Force
      Write-Log ("Pruned {0}" -f $old.Name)
    }
  }
  $kept = [math]::Min($all.Count, $Keep)
  Write-Log ("Done in {0:n1}s - {1} backup(s) on file" -f ((Get-Date) - $started).TotalSeconds, $kept)
  exit 0
}
catch {
  Write-Log $_.Exception.Message 'ERROR'
  exit 1
}
