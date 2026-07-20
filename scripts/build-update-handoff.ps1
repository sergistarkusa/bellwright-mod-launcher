Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourcePath = Join-Path $projectRoot "runtime\update-handoff.cs"
$outputPath = Join-Path $projectRoot "runtime\BellwrightUpdateHandoff.exe"

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Update handoff source was not found: $sourcePath"
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Force
}

$source = Get-Content -Raw -LiteralPath $sourcePath
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.GenerateInMemory = $false
$parameters.OutputAssembly = $outputPath
$parameters.CompilerOptions = "/target:winexe /platform:x64 /optimize+"
$parameters.ReferencedAssemblies.Add("System.dll") | Out-Null
$results = $provider.CompileAssemblyFromSource($parameters, $source)
$provider.Dispose()

if ($results.Errors.HasErrors) {
  $messages = @($results.Errors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  throw "Update handoff compilation failed:$([Environment]::NewLine)$messages"
}

if (-not (Test-Path -LiteralPath $outputPath)) {
  throw "Update handoff build did not create $outputPath"
}

Get-Item -LiteralPath $outputPath | Select-Object FullName, Length
