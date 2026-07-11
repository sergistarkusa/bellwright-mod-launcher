Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJson = Get-Content -Raw -LiteralPath (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$version = $packageJson.version
$electronDist = Join-Path $projectRoot "node_modules\electron\dist"
$distRoot = Join-Path $projectRoot "dist"
$releaseRoot = Join-Path $projectRoot "release"
$outName = "BellwrightModLauncher-v$version-win-x64-portable"
$outDir = Join-Path $distRoot $outName
$zipPath = Join-Path $releaseRoot "$outName.zip"

if (-not (Test-Path -LiteralPath (Join-Path $electronDist "electron.exe"))) {
  throw "Electron runtime not found. Run npm install first."
}

$projectRootPath = $projectRoot.Path.TrimEnd('\')
foreach ($candidate in @($distRoot, $releaseRoot, $outDir)) {
  $full = [System.IO.Path]::GetFullPath($candidate)
  if (-not $full.StartsWith($projectRootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside project root: $full"
  }
}

New-Item -ItemType Directory -Force -Path $distRoot, $releaseRoot | Out-Null
if (Test-Path -LiteralPath $outDir) {
  Remove-Item -LiteralPath $outDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Copy-Item -LiteralPath $electronDist -Destination $outDir -Recurse
Rename-Item -LiteralPath (Join-Path $outDir "electron.exe") -NewName "BellwrightModLauncher.exe"

$appRoot = Join-Path $outDir "resources\app"
New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "main.js") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "native-runtime.js") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "preload.js") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "package-lock.json") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "renderer") -Destination $appRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "runtime") -Destination $appRoot -Recurse

$zipSafeDate = [DateTime]"2026-01-01T00:00:00"
Get-ChildItem -LiteralPath $outDir -Recurse -Force | ForEach-Object {
  if ($_.LastWriteTime -lt [DateTime]"1980-01-01T00:00:00") {
    $_.LastWriteTime = $zipSafeDate
  }
}

Compress-Archive -LiteralPath $outDir -DestinationPath $zipPath -CompressionLevel Optimal
Get-Item -LiteralPath $zipPath | Select-Object FullName, Length
