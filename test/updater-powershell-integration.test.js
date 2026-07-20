const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const updaterSource = path.join(root, "runtime", "apply-update.ps1");
const handoff = path.join(root, "runtime", "BellwrightUpdateHandoff.exe");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");

function compileLauncher(exePath, { exitImmediately = false, typeName }) {
  const sourcePath = `${exePath}.cs`;
  const behavior = exitImmediately
    ? 'File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "failed-new.marker"), "started");'
    : 'File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "restart.marker"), Process.GetCurrentProcess().Id.ToString()); Thread.Sleep(8000);';
  fs.writeFileSync(
    sourcePath,
    `using System; using System.Diagnostics; using System.IO; using System.Threading; public static class ${typeName} { [STAThread] public static void Main() { ${behavior} } }`
  );
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Add-Type -Path ${quote(sourcePath)} -OutputAssembly ${quote(exePath)} -OutputType WindowsApplication`
    ],
    { encoding: "utf8", timeout: 60000 }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(sourcePath, { force: true });
}

function createPackage(folder, version, executablePath) {
  fs.mkdirSync(path.join(folder, "resources", "app"), { recursive: true });
  fs.copyFileSync(executablePath, path.join(folder, "BellwrightModLauncher.exe"));
  fs.writeFileSync(
    path.join(folder, "resources", "app", "package.json"),
    JSON.stringify({ name: "bellwright-mod-launcher", version })
  );
  fs.writeFileSync(path.join(folder, "payload.txt"), `payload-${version}`);
}

function runUpdater({ installDir, stagedDir, updateRoot, expectedVersion }) {
  const scriptPath = path.join(updateRoot, "apply-update.ps1");
  const logPath = path.join(updateRoot, "apply-update.log");
  fs.copyFileSync(updaterSource, scriptPath);
  fs.writeFileSync(logPath, "integration test scheduled\n");
  return spawnSync(
    powershell,
    [
      "-WindowStyle",
      "Hidden",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-InstallDir",
      installDir,
      "-StagedAppDir",
      stagedDir,
      "-UpdateRoot",
      updateRoot,
      "-ExeName",
      "BellwrightModLauncher.exe",
      "-ExpectedVersion",
      expectedVersion,
      "-UserDataDir",
      path.dirname(path.dirname(updateRoot)),
      "-ProcessId",
      String(process.pid),
      "-LogPath",
      logPath
    ],
    {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        BELLWRIGHT_UPDATER_SUPPRESS_ERROR_DIALOG: "1"
      }
    }
  );
}

function startUpdaterThroughHandoff({ installDir, stagedDir, updateRoot, expectedVersion }) {
  const scriptPath = path.join(updateRoot, "apply-update.ps1");
  const logPath = path.join(updateRoot, "apply-update.log");
  fs.copyFileSync(updaterSource, scriptPath);
  fs.writeFileSync(logPath, "integration test scheduled through GUI handoff\n");
  return spawnSync(
    handoff,
    [
      "--log",
      logPath,
      powershell,
      "-WindowStyle",
      "Hidden",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-InstallDir",
      installDir,
      "-StagedAppDir",
      stagedDir,
      "-UpdateRoot",
      updateRoot,
      "-ExeName",
      "BellwrightModLauncher.exe",
      "-ExpectedVersion",
      expectedVersion,
      "-UserDataDir",
      path.dirname(path.dirname(updateRoot)),
      "-ProcessId",
      String(process.pid),
      "-LogPath",
      logPath
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        BELLWRIGHT_UPDATER_SUPPRESS_ERROR_DIALOG: "1"
      }
    }
  );
}

function waitFor(predicate, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.fail(message);
}

function killMarkerProcess(installDir) {
  const marker = path.join(installDir, "restart.marker");
  if (!fs.existsSync(marker)) {
    return;
  }
  const pid = Number.parseInt(fs.readFileSync(marker, "utf8").replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(pid)) {
    spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

function removeTestRoot(testRoot) {
  const escapedRoot = String(testRoot).replaceAll("'", "''");
  const command = [
    `$root=[System.IO.Path]::GetFullPath('${escapedRoot}')`,
    "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\\\\',[System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Start-Sleep -Milliseconds 300",
    "for($attempt=0;$attempt -lt 150 -and [System.IO.Directory]::Exists($root);$attempt++){try{[System.IO.Directory]::Delete($root,$true)}catch{Start-Sleep -Milliseconds 100}}",
    "if([System.IO.Directory]::Exists($root)){throw \"Could not remove test root $root\"}"
  ].join("; ");
  const result = spawnSync(powershell, ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertNoUpdaterArtifacts(programsRoot, updatesRoot) {
  const siblingArtifacts = fs.existsSync(programsRoot)
    ? fs.readdirSync(programsRoot).filter((name) => /\.(?:new|old)-\d{17}$/i.test(name))
    : [];
  assert.deepEqual(siblingArtifacts, []);
  assert.equal(fs.existsSync(updatesRoot), false);
}

test("PowerShell updater leaves only the verified current installation after success", { skip: process.platform !== "win32" }, () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bellwright-updater-success-"));
  const programsRoot = path.join(testRoot, "programs");
  const installDir = path.join(programsRoot, "BellwrightModLauncher");
  const updatesRoot = path.join(testRoot, "user-data", "updates");
  const updateRoot = path.join(updatesRoot, "0.5.9-test");
  const stagedDir = path.join(updateRoot, "extracted", "BellwrightModLauncher");
  const oldExe = path.join(testRoot, "old-launcher.exe");
  const newExe = path.join(testRoot, "new-launcher.exe");
  try {
    fs.mkdirSync(updateRoot, { recursive: true });
    compileLauncher(oldExe, { typeName: "OldLauncherSuccess059" });
    compileLauncher(newExe, { typeName: "NewLauncherSuccess059" });
    createPackage(installDir, "0.5.8", oldExe);
    createPackage(stagedDir, "0.5.9", newExe);

    const result = runUpdater({ installDir, stagedDir, updateRoot, expectedVersion: "0.5.9" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, "resources", "app", "package.json"))).version, "0.5.9");
    assert.equal(fs.readFileSync(path.join(installDir, "payload.txt"), "utf8"), "payload-0.5.9");
    assert.equal(fs.existsSync(path.join(installDir, "restart.marker")), true);
    assertNoUpdaterArtifacts(programsRoot, updatesRoot);
  } finally {
    killMarkerProcess(installDir);
    removeTestRoot(testRoot);
  }
});

test("GUI-safe handoff completes a full update without a console parent", { skip: process.platform !== "win32" }, () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bellwright-updater-handoff-"));
  const programsRoot = path.join(testRoot, "programs");
  const installDir = path.join(programsRoot, "BellwrightModLauncher");
  const updatesRoot = path.join(testRoot, "user-data", "updates");
  const updateRoot = path.join(updatesRoot, "0.6.0-test");
  const stagedDir = path.join(updateRoot, "extracted", "BellwrightModLauncher");
  const oldExe = path.join(testRoot, "old-launcher.exe");
  const newExe = path.join(testRoot, "new-launcher.exe");
  try {
    fs.mkdirSync(updateRoot, { recursive: true });
    compileLauncher(oldExe, { typeName: "OldLauncherHandoff060" });
    compileLauncher(newExe, { typeName: "NewLauncherHandoff060" });
    createPackage(installDir, "0.5.10", oldExe);
    createPackage(stagedDir, "0.6.0", newExe);

    const result = startUpdaterThroughHandoff({ installDir, stagedDir, updateRoot, expectedVersion: "0.6.0" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    waitFor(
      () => {
        const siblings = fs.existsSync(programsRoot)
          ? fs.readdirSync(programsRoot).filter((name) => /\.(?:new|old)-\d{17}$/i.test(name))
          : [];
        return fs.existsSync(path.join(installDir, "restart.marker")) &&
          !fs.existsSync(updatesRoot) &&
          siblings.length === 0;
      },
      "GUI-safe update handoff did not finish"
    );

    assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, "resources", "app", "package.json"))).version, "0.6.0");
    assert.equal(fs.readFileSync(path.join(installDir, "payload.txt"), "utf8"), "payload-0.6.0");
    assertNoUpdaterArtifacts(programsRoot, updatesRoot);
  } finally {
    killMarkerProcess(installDir);
    removeTestRoot(testRoot);
  }
});

test("PowerShell updater restores the old version and removes staging after a recoverable restart failure", { skip: process.platform !== "win32" }, () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bellwright-updater-rollback-"));
  const programsRoot = path.join(testRoot, "programs");
  const installDir = path.join(programsRoot, "BellwrightModLauncher");
  const updatesRoot = path.join(testRoot, "user-data", "updates");
  const updateRoot = path.join(updatesRoot, "0.5.9-test");
  const stagedDir = path.join(updateRoot, "extracted", "BellwrightModLauncher");
  const oldExe = path.join(testRoot, "old-launcher.exe");
  const failingExe = path.join(testRoot, "failing-launcher.exe");
  try {
    fs.mkdirSync(updateRoot, { recursive: true });
    compileLauncher(oldExe, { typeName: "OldLauncherRollback059" });
    compileLauncher(failingExe, { exitImmediately: true, typeName: "FailingLauncherRollback059" });
    createPackage(installDir, "0.5.8", oldExe);
    createPackage(stagedDir, "0.5.9", failingExe);

    const result = runUpdater({ installDir, stagedDir, updateRoot, expectedVersion: "0.5.9" });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, "resources", "app", "package.json"))).version, "0.5.8");
    assert.equal(fs.readFileSync(path.join(installDir, "payload.txt"), "utf8"), "payload-0.5.8");
    assert.equal(fs.existsSync(path.join(installDir, "restart.marker")), true);
    assertNoUpdaterArtifacts(programsRoot, updatesRoot);
  } finally {
    killMarkerProcess(installDir);
    removeTestRoot(testRoot);
  }
});
