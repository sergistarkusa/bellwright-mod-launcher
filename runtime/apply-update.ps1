param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$StagedAppDir,
  [Parameter(Mandatory=$true)][string]$UpdateRoot,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$UserDataDir,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-UpdateLog([string]$Message) {
  try {
    $parent = Split-Path -Parent $LogPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $LogPath -Value $line
  } catch {
    # Logging must never prevent rollback or cleanup.
  }
}

function Invoke-WithRetry([scriptblock]$Action, [string]$Description) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    try {
      & $Action
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 250
    }
  }
  throw "$Description failed after retries: $($lastError.Exception.Message)"
}

function Copy-DirectoryContents([string]$Source, [string]$Destination, [string]$Description) {
  $items = @(Get-ChildItem -LiteralPath $Source -Force)
  if ($items.Count -eq 0) {
    throw "$Description failed because the source folder is empty."
  }
  $items | Copy-Item -Destination $Destination -Recurse -Force
}

function Clear-DirectoryWithRetry([string]$Directory, [string]$Description) {
  Invoke-WithRetry {
    @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction SilentlyContinue) |
      Remove-Item -Recurse -Force
  } $Description
}

function Remove-DirectoryWithRetry([string]$Directory, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Directory)) {
    return
  }
  Invoke-WithRetry {
    Remove-Item -LiteralPath $Directory -Recurse -Force
  } $Description
  if (Test-Path -LiteralPath $Directory) {
    throw "$Description did not remove $Directory."
  }
}

function Remove-EmptyParent([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory)) {
    return
  }
  $items = @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction SilentlyContinue)
  if ($items.Count -eq 0) {
    Remove-Item -LiteralPath $Directory -Force -ErrorAction SilentlyContinue
  }
}

function Get-PackageVersion([string]$ApplicationRoot) {
  $packagePath = Join-Path $ApplicationRoot "resources\app\package.json"
  if (-not (Test-Path -LiteralPath $packagePath)) {
    return $null
  }
  return [string]((Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json).version)
}

function Get-ProcessesFromDirectory([string]$Directory) {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    try {
      $candidate = [System.IO.Path]::GetFullPath($_.ExecutablePath)
      return $candidate.StartsWith($Directory + '\', [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      return $false
    }
  })
}

function Show-UpdateFailure([string]$Message) {
  if ($env:BELLWRIGHT_UPDATER_SUPPRESS_ERROR_DIALOG -eq "1") {
    return
  }
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      $Message,
      "Bellwright Mod Launcher update failed",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
  } catch {
    # A graphical error dialog is best effort on headless or damaged systems.
  }
}

$install = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$staged = [System.IO.Path]::GetFullPath($StagedAppDir).TrimEnd('\')
$update = [System.IO.Path]::GetFullPath($UpdateRoot).TrimEnd('\')
$updatesParent = Split-Path -Parent $update
$userData = [System.IO.Path]::GetFullPath($UserDataDir).TrimEnd('\')
$userDataArgument = "--user-data-dir=`"$userData`""
$driveRoot = [System.IO.Path]::GetPathRoot($install).TrimEnd('\')
$updateDriveRoot = [System.IO.Path]::GetPathRoot($update).TrimEnd('\')
$parent = Split-Path -Parent $install
$leaf = Split-Path -Leaf $install
$stamp = Get-Date -Format yyyyMMddHHmmssfff
$backup = Join-Path $parent "$leaf.old-$stamp"
$replacement = Join-Path $parent "$leaf.new-$stamp"
$backupCreated = $false
$installModified = $false
$launchedProcess = $null

try {
  if (Test-Path -LiteralPath $update) {
    Set-Location -LiteralPath $update
  } else {
    Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
  }

  Write-UpdateLog "Starting update from process $ProcessId. Install=$install Staged=$staged"

  if ($install -eq $driveRoot -or $update -eq $updateDriveRoot) {
    throw "Refusing to update or clean a drive root."
  }
  if ($install.StartsWith($update + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
      $update.StartsWith($install + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Install and update staging folders must not contain one another."
  }
  if (-not $staged.StartsWith($update + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Staged application is outside the disposable update folder."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $install $ExeName))) {
    throw "Install folder does not contain $ExeName."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $staged $ExeName))) {
    throw "Staged update does not contain $ExeName."
  }
  $stagedVersion = Get-PackageVersion $staged
  if ($stagedVersion -ne $ExpectedVersion) {
    throw "Staged update version $stagedVersion does not match expected version $ExpectedVersion."
  }

  Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^$([Regex]::Escape($leaf))\.(?:new|old)-\d{17}$" } |
    ForEach-Object { Remove-DirectoryWithRetry $_.FullName "Removing stale updater folder" }

  New-Item -ItemType Directory -Path $replacement | Out-Null
  try {
    Copy-DirectoryContents $staged $replacement "Preparing the replacement"
  } catch {
    Remove-DirectoryWithRetry $replacement "Removing incomplete replacement"
    throw
  }
  if ((Get-PackageVersion $replacement) -ne $ExpectedVersion) {
    throw "Prepared replacement failed version verification."
  }

  $deadline = (Get-Date).AddSeconds(20)
  do {
    $running = @(Get-ProcessesFromDirectory $install)
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  if ($running.Count -gt 0) {
    Write-UpdateLog "Stopping lingering launcher processes: $($running.ProcessId -join ',')"
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 750
  }
  if (@(Get-ProcessesFromDirectory $install).Count -gt 0) {
    throw "Launcher processes are still using the install folder."
  }

  New-Item -ItemType Directory -Path $backup | Out-Null
  Copy-DirectoryContents $install $backup "Backing up the current installation"
  $backupCreated = $true

  Clear-DirectoryWithRetry $install "Clearing the current installation"
  $installModified = $true
  Copy-DirectoryContents $replacement $install "Activating the new installation"
  if (-not (Test-Path -LiteralPath (Join-Path $install $ExeName)) -or
      (Get-PackageVersion $install) -ne $ExpectedVersion) {
    throw "Activated installation failed executable or version verification."
  }

  Remove-DirectoryWithRetry $replacement "Removing prepared replacement"
  Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
  Write-UpdateLog "Activation verified. Removing downloaded update files."
  Remove-DirectoryWithRetry $update "Removing downloaded update files"
  Remove-EmptyParent $updatesParent

  $exePath = Join-Path $install $ExeName
  $launchedProcess = Start-Process -FilePath $exePath -WorkingDirectory $install -ArgumentList $userDataArgument -PassThru
  Start-Sleep -Milliseconds 1500
  $launchedProcess.Refresh()
  if ($launchedProcess.HasExited) {
    throw "Updated launcher exited before restart verification completed."
  }

  Remove-DirectoryWithRetry $backup "Removing previous launcher version"
  $backupCreated = $false
  exit 0
} catch {
  $failure = $_.Exception.Message
  Write-UpdateLog "Update failed: $failure"
  if ($launchedProcess -and -not $launchedProcess.HasExited) {
    Stop-Process -Id $launchedProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }

  $rollbackSucceeded = $false
  $rollbackFailure = $null
  try {
    if ($backupCreated -and (Test-Path -LiteralPath $backup)) {
      Clear-DirectoryWithRetry $install "Clearing the failed update"
      Copy-DirectoryContents $backup $install "Restoring the previous installation"
      if (-not (Test-Path -LiteralPath (Join-Path $install $ExeName))) {
        throw "Restored installation does not contain $ExeName."
      }
      $rollbackSucceeded = $true
    } elseif (-not $installModified -and (Test-Path -LiteralPath (Join-Path $install $ExeName))) {
      $rollbackSucceeded = $true
    }
  } catch {
    $rollbackFailure = $_.Exception.Message
  }

  if ($rollbackSucceeded) {
    $cleanupFailures = @()
    foreach ($artifact in @($replacement, $backup, $update)) {
      try {
        Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
        Remove-DirectoryWithRetry $artifact "Removing failed update artifact"
      } catch {
        $cleanupFailures += $_.Exception.Message
      }
    }
    Remove-EmptyParent $updatesParent

    try {
      Start-Process -FilePath (Join-Path $install $ExeName) -WorkingDirectory $install -ArgumentList $userDataArgument | Out-Null
    } catch {
      $failure = "$failure Previous version was restored but could not be restarted: $($_.Exception.Message)"
    }

    $message = "The update was not applied. The previous launcher version was restored and restarted.`n`n$failure"
    if ($cleanupFailures.Count -gt 0) {
      $message += "`n`nSome failed update artifacts could not be removed:`n$($cleanupFailures -join "`n")"
    }
    Show-UpdateFailure $message
  } else {
    $message = "The update failed and automatic rollback could not be completed. Recovery files were preserved to avoid data loss.`n`nUpdate error: $failure"
    if ($rollbackFailure) {
      $message += "`nRollback error: $rollbackFailure"
    }
    $message += "`nBackup: $backup`nStaging: $update"
    Show-UpdateFailure $message
  }
  Write-Error $message
  exit 1
}
