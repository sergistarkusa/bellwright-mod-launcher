param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$StagedAppDir,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-UpdateLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $LogPath -Value $line
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

try {
  $updaterWorkingDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($LogPath))
  if (Test-Path -LiteralPath $updaterWorkingDir) {
    Set-Location -LiteralPath $updaterWorkingDir
  } else {
    Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
  }

  $install = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $staged = [System.IO.Path]::GetFullPath($StagedAppDir).TrimEnd('\')
  $driveRoot = [System.IO.Path]::GetPathRoot($install).TrimEnd('\')

  Write-UpdateLog "Starting update. Install=$install Staged=$staged"

  if ($install -eq $driveRoot) {
    throw "Refusing to update a drive root."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $install $ExeName))) {
    throw "Install folder does not contain $ExeName."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $staged $ExeName))) {
    throw "Staged update does not contain $ExeName."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $staged "resources\app\package.json"))) {
    throw "Staged update is missing resources\app\package.json."
  }

  $parent = Split-Path -Parent $install
  $leaf = Split-Path -Leaf $install
  $stamp = Get-Date -Format yyyyMMddHHmmssfff
  $backup = Join-Path $parent "$leaf.old-$stamp"
  $replacement = Join-Path $parent "$leaf.new-$stamp"

  New-Item -ItemType Directory -Path $replacement | Out-Null
  try {
    $items = @(Get-ChildItem -LiteralPath $staged -Force)
    if ($items.Count -eq 0) {
      throw "Staged update folder is empty."
    }
    $items | Copy-Item -Destination $replacement -Recurse -Force
  } catch {
    Remove-Item -LiteralPath $replacement -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }

  $deadline = (Get-Date).AddSeconds(20)
  do {
    $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      if (-not $_.ExecutablePath) { return $false }
      try {
        $candidate = [System.IO.Path]::GetFullPath($_.ExecutablePath)
        return $candidate.StartsWith($install + '\', [System.StringComparison]::OrdinalIgnoreCase)
      } catch {
        return $false
      }
    })
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  if ($running.Count -gt 0) {
    Write-UpdateLog "Stopping lingering launcher processes: $($running.ProcessId -join ',')"
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 750
  }

  $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    try {
      $candidate = [System.IO.Path]::GetFullPath($_.ExecutablePath)
      return $candidate.StartsWith($install + '\', [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      return $false
    }
  })
  if ($remaining.Count -gt 0) {
    throw "Launcher processes are still using the install folder."
  }

  New-Item -ItemType Directory -Path $backup | Out-Null
  $installedItems = @(Get-ChildItem -LiteralPath $install -Force)
  if ($installedItems.Count -eq 0) {
    throw "The current installation folder is empty."
  }
  $installedItems | Copy-Item -Destination $backup -Recurse -Force

  try {
    Invoke-WithRetry {
      @(Get-ChildItem -LiteralPath $install -Force) |
        Remove-Item -Recurse -Force
    } "Clearing the current installation"
    $replacementItems = @(Get-ChildItem -LiteralPath $replacement -Force)
    $replacementItems | Copy-Item -Destination $install -Recurse -Force
  } catch {
    @(Get-ChildItem -LiteralPath $install -Force -ErrorAction SilentlyContinue) |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $backup) {
      @(Get-ChildItem -LiteralPath $backup -Force) |
        Copy-Item -Destination $install -Recurse -Force
    }
    throw
  }

  $exePath = Join-Path $install $ExeName
  Start-Process -FilePath $exePath -WorkingDirectory $install
  Start-Sleep -Milliseconds 750
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $replacement -Recurse -Force -ErrorAction SilentlyContinue
  Write-UpdateLog "Update applied and launcher restarted."
} catch {
  Write-UpdateLog "Update failed: $($_.Exception.Message)"
}
