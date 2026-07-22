const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer", "renderer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer", "styles.css"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const packageScript = fs.readFileSync(path.join(root, "scripts", "package-windows.ps1"), "utf8");
const index = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
const updater = fs.readFileSync(path.join(root, "runtime", "apply-update.ps1"), "utf8");
const handoffSource = fs.readFileSync(path.join(root, "runtime", "update-handoff.cs"), "utf8");
const updateCleanup = fs.readFileSync(path.join(root, "update-cleanup.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("updater uses Node crypto instead of Electron's Web Crypto global", () => {
  assert.match(main, /const nodeCrypto = require\("node:crypto"\);/);
  assert.match(main, /nodeCrypto\.randomBytes\(4\)/);
  assert.doesNotMatch(main, /(?<!nodeCrypto\.)crypto\.randomBytes\(/);
});

test("updater is relaunched through a GUI-safe handoff after Electron exits", () => {
  const handoff = main.match(/async function startUpdaterAndQuit[\s\S]*?\r?\n}\r?\n\r?\nasync function updateLauncher/)?.[0] || "";
  assert.match(handoff, /app\.relaunch\(\{/);
  assert.match(handoff, /execPath: handoffPath/);
  assert.match(handoff, /"--log",\s*logPath,\s*powershellPath/s);
  assert.doesNotMatch(handoff, /execPath: powershellPath/);
  assert.match(handoff, /app\.exit\(0\)/);
  assert.doesNotMatch(handoff, /childProcess\.spawn/);
  assert.match(handoffSource, /CreateNoWindow\s*=\s*0x08000000/);
  assert.match(handoffSource, /false,\s*CreateNoWindow,/s);
  assert.match(handoffSource, /hStdInput\s*=\s*IntPtr\.Zero/);
  assert.match(handoffSource, /hStdOutput\s*=\s*IntPtr\.Zero/);
  assert.match(handoffSource, /hStdError\s*=\s*IntPtr\.Zero/);
});

test("updater leaves the installation and staging directories before cleanup", () => {
  assert.match(updater, /Set-Location -LiteralPath \$update/);
  assert.match(updater, /Set-Location -LiteralPath \(\[System\.IO\.Path\]::GetTempPath\(\)\)/);
  const successCleanup = updater.match(/Remove-DirectoryWithRetry \$replacement[\s\S]*?Remove-DirectoryWithRetry \$update/)?.[0] || "";
  assert.match(successCleanup, /Set-Location -LiteralPath \(\[System\.IO\.Path\]::GetTempPath\(\)\)/);
});

test("updater replaces contents without renaming the stable installation folder", () => {
  assert.doesNotMatch(updater, /Rename-Item -LiteralPath \$install/);
  assert.match(updater, /Clearing the current installation/);
  assert.match(updater, /Copy-DirectoryContents \$replacement \$install "Activating the new installation"/);
  assert.match(updater, /Copy-DirectoryContents \$install \$backup "Backing up the current installation"/);
});

test("successful updates verify restart and remove every disposable artifact", () => {
  assert.match(main, /verifyDownloadedAsset\(asset, zipPath\)/);
  assert.match(main, /"-WindowStyle",\s*"Hidden"/s);
  assert.match(main, /"-UserDataDir",\s*app\.getPath\("userData"\)/s);
  assert.match(updater, /Get-PackageVersion \$install/);
  assert.match(updater, /Updated launcher exited before restart verification completed/);
  assert.match(updater, /Remove-DirectoryWithRetry \$replacement "Removing prepared replacement"/);
  assert.match(updater, /Remove-DirectoryWithRetry \$update "Removing downloaded update files"/);
  assert.match(updater, /Remove-DirectoryWithRetry \$backup "Removing previous launcher version"/);
  assert.match(main, /cleanupStaleLauncherUpdates/);
  assert.match(main, /currentExecutablePath: process\.execPath/);
  assert.match(main, /if \(updateInProgress\) \{\s*scheduleStaleUpdateCleanup\(5000, retryAttempt\)/s);
  assert.match(main, /scheduleStaleUpdateCleanup\(retryDelayMs, retryAttempt \+ 1\)/);
  assert.match(updateCleanup, /maxRetries: 8/);
  assert.match(updateCleanup, /RETRYABLE_REMOVAL_CODES/);
  assert.match(main, /function scheduleActiveUpdateSessionCleanup\(\)/);
  assert.match(updateCleanup, /Wait-Process -Id \$launcherProcessId/);
  const deferredCleanup = main.match(/function scheduleActiveUpdateSessionCleanup[\s\S]*?\r?\n}\r?\n\r?\nfunction scheduleStaleUpdateCleanup/)?.[0] || "";
  assert.match(deferredCleanup, /"-WindowStyle",\s*"Hidden"/s);
  assert.match(deferredCleanup, /windowsHide: true/);
  assert.match(packageScript, /update-cleanup\.js/);
  assert.match(packageScript, /native-signature\.js/);
  assert.match(packageScript, /native-discovery\.js/);
  assert.match(packageScript, /build-update-handoff\.ps1/);
});

test("recoverable update failures restore, restart, and clean up", () => {
  assert.match(updater, /Copy-DirectoryContents \$backup \$install "Restoring the previous installation"/);
  assert.match(updater, /Start-Process -FilePath \(Join-Path \$install \$ExeName\)/);
  assert.match(updater, /Show-UpdateFailure \$message/);
  assert.match(updater, /foreach \(\$artifact in @\(\$replacement, \$backup, \$update\)\)/);
  assert.match(updater, /Recovery files were preserved to avoid data loss/);
});

test("portable archive is versioned but its application folder is stable", () => {
  assert.match(packageScript, /\$archiveName = "BellwrightModLauncher-v\$version-win-x64-portable"/);
  assert.match(packageScript, /\$appFolderName = "BellwrightModLauncher"/);
  assert.match(packageScript, /\$zipPath = Join-Path \$releaseRoot "\$archiveName\.zip"/);
  assert.doesNotMatch(packageScript, /\$outDir = Join-Path \$distRoot \$archiveName/);
  assert.match(packageScript, /Remove-Item -LiteralPath \$defaultElectronApp -Force/);
});

test("public launcher branding uses ExcelsiorOne", () => {
  const retiredBrand = ["FSD", "Software"].join(" ");
  assert.match(main, /maker: "ExcelsiorOne"/);
  assert.match(renderer, /Support ExcelsiorOne/);
  assert.match(index, /aria-label="ExcelsiorOne"/);
  assert.match(license, /Copyright \(c\) 2026 ExcelsiorOne/);
  assert.doesNotMatch([main, renderer, index, license].join("\n"), new RegExp(retiredBrand, "i"));
});

test("update badge appears only after a confirmed background release check", () => {
  assert.match(index, /id="updateAvailabilityBadge"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(styles, /\.updateAvailabilityBadge\s*\{[^}]*position:\s*absolute[^}]*border-radius:\s*50%/s);
  assert.match(styles, /\.updateAvailabilityBadge\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(preload, /checkLauncherUpdate:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("app:checkLauncherUpdate"\)/);
  assert.match(main, /async function checkLauncherUpdate\(\)[\s\S]*?status:\s*"unsupported"[\s\S]*?fetchLatestRelease\(\)/);
  assert.match(main, /result\.status === "available" && !findUpdateAsset\(release\)\?\.browser_download_url/);
  assert.match(renderer, /result\?\.status === "available"/);
  assert.match(renderer, /void checkLauncherUpdateAvailability\(\)/);
  assert.match(renderer, /background network failure means the update state is unknown, not available/);
});

test("never scales the complete launcher to fit the mod count", () => {
  assert.doesNotMatch(renderer, /\.style\.zoom|fitContentToWindow|--content-scale/);
  assert.doesNotMatch(renderer, /devicePixelRatio/);
});

test("large mod lists scroll independently without shrinking cards", () => {
  assert.match(styles, /\.shell\s*\{[^}]*height:\s*calc\(100vh\s*-\s*50px\)/s);
  assert.match(styles, /\.board\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.modColumn\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.columnList\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.modCard\s*\{[^}]*min-height:\s*42px/s);
  assert.match(styles, /\.topbar,[\s\S]*\.statusStrip,[\s\S]*\.controls,[\s\S]*\.updateProgress\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
});

test("conflict details accept independent mouse scrolling", () => {
  assert.match(styles, /\.conflictTooltip\s*\{[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain[^}]*pointer-events:\s*auto/s);
  assert.doesNotMatch(styles, /\.conflictTooltip\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(renderer, /conflictTooltip\.addEventListener\("mouseenter", cancelConflictTooltipHide\)/);
  assert.match(renderer, /conflictTooltip\.addEventListener\("mouseleave", scheduleConflictTooltipHide\)/);
  assert.doesNotMatch(renderer, /conflictBadgeElement\.addEventListener\("mousemove"/);
});

test("large-list visual fixture exercises 200 active mods", () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "large-list.html"), "utf8");
  assert.match(fixture, /activeCount\s*=\s*Number\(params\.get\("active"\)\s*\|\|\s*200\)/);
});

test("v0.5.8 and newer users retain the automatic path into v0.6.1", () => {
  assert.match(readme, /Upgrading from v0\.5\.8 or newer:[\s\S]*normal Update button/);
  assert.match(readme, /can install v0\.6\.1 automatically/);
  assert.doesNotMatch(readme, /v0\.5\.10 or older:[\s\S]*manually/);
});

test("persistent native trust explicitly covers future replacement DLLs", () => {
  assert.match(main, /buttons: \["Cancel", "Allow this DLL", "Trust future updates"\]/);
  assert.match(main, /"Allow this DLL" approves only this exact file/);
  assert.match(main, /"Trust future updates" also approves replacement DLLs downloaded later for this same mod/);
});

test("a stale state refresh cannot overwrite a newer native-runtime event", () => {
  assert.match(renderer, /let nativeRuntimeRevision = 0/);
  assert.match(renderer, /const nativeRevisionAtStart = nativeRuntimeRevision/);
  assert.match(renderer, /nativeRuntimeRevision !== nativeRevisionAtStart && latestNativeRuntime/);
  assert.match(renderer, /mergeNativeRuntimeIntoState\(nextState, latestNativeRuntime\)/);
  assert.match(renderer, /function handleNativeRuntimeChanged\(runtime\) \{\s*latestNativeRuntime = runtime;\s*nativeRuntimeRevision \+= 1;/s);
});
