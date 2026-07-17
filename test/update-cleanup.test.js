const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildPostExitCleanupCommand,
  cleanupUpdateArtifacts,
  findContainingUpdateSession,
  isKnownUpdateArtifact,
  removeTreeWithRetry,
  removeUpdateSession
} = require("../update-cleanup");

async function makePackagedFolder(parent, name, version) {
  const folder = path.join(parent, name);
  await fs.mkdir(path.join(folder, "resources", "app"), { recursive: true });
  await fs.writeFile(path.join(folder, "BellwrightModLauncher.exe"), "test executable");
  await fs.writeFile(
    path.join(folder, "resources", "app", "package.json"),
    JSON.stringify({ name: "bellwright-mod-launcher", version })
  );
  return folder;
}

test("recognizes updater-created sibling folders without matching ordinary folders", () => {
  assert.equal(isKnownUpdateArtifact("BellwrightModLauncher.new-20260716231851080", "BellwrightModLauncher"), true);
  assert.equal(
    isKnownUpdateArtifact(
      "BellwrightModLauncher-v0.5.3-win-x64-portable.old-20260716231851080",
      "BellwrightModLauncher"
    ),
    true
  );
  assert.equal(isKnownUpdateArtifact("BellwrightModLauncher-backup", "BellwrightModLauncher"), false);
  assert.equal(isKnownUpdateArtifact("Unrelated.new-20260716231851080", "BellwrightModLauncher"), false);
});

test("retries transient Windows removal failures", async () => {
  let calls = 0;
  const delays = [];
  await removeTreeWithRetry("disposable-update-folder", {
    attempts: 4,
    retryDelayMs: 10,
    rm: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("temporarily locked");
        error.code = "EBUSY";
        throw error;
      }
    },
    waitForRetry: async (delayMs) => delays.push(delayMs)
  });

  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("defers the update session containing the running executable", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bellwright-active-update-cleanup-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "user-data");
  const installDir = await makePackagedFolder(path.join(root, "programs"), "BellwrightModLauncher", "0.5.10");
  const activeSession = path.join(userDataPath, "updates", "0.5.10-active");
  const activeExecutable = path.join(
    activeSession,
    "extracted",
    "BellwrightModLauncher",
    "BellwrightModLauncher.exe"
  );
  const staleSession = path.join(userDataPath, "updates", "0.5.9-stale");
  await fs.mkdir(path.dirname(activeExecutable), { recursive: true });
  await fs.writeFile(activeExecutable, "running executable");
  await fs.mkdir(staleSession, { recursive: true });
  await fs.writeFile(path.join(staleSession, "default_app.asar"), "stale lock");

  assert.equal(findContainingUpdateSession(userDataPath, activeExecutable), activeSession);
  assert.equal(findContainingUpdateSession(userDataPath, path.join(installDir, "BellwrightModLauncher.exe")), null);

  const removed = await cleanupUpdateArtifacts({
    userDataPath,
    installDir,
    currentVersion: "0.5.10",
    currentExecutablePath: activeExecutable
  });

  assert.equal(await fs.stat(activeExecutable).then(() => true), true);
  await assert.rejects(fs.access(staleSession));
  assert.ok(removed.includes(staleSession));
  assert.equal(await fs.stat(path.join(userDataPath, "updates")).then(() => true), true);
});

test("hidden PowerShell cleanup removes an active session after its process exits", { skip: process.platform !== "win32" }, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bellwright-post-exit-cleanup-"));
  const session = path.join(root, "updates", "0.5.10-active");
  await fs.mkdir(session, { recursive: true });
  await fs.writeFile(path.join(session, "default_app.asar"), "locked until exit");
  const sleeper = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 750)"], {
    stdio: "ignore",
    windowsHide: true
  });
  const powershellPath = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const cleaner = childProcess.spawn(
    powershellPath,
    [
      "-WindowStyle",
      "Hidden",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      buildPostExitCleanupCommand()
    ],
    {
      env: {
        ...process.env,
        BELLWRIGHT_CLEANUP_PROCESS_ID: String(sleeper.pid),
        BELLWRIGHT_CLEANUP_TARGET: session
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  let cleanupStdout = "";
  let cleanupStderr = "";
  cleaner.stdout.on("data", (chunk) => { cleanupStdout += chunk.toString(); });
  cleaner.stderr.on("data", (chunk) => { cleanupStderr += chunk.toString(); });
  context.after(async () => {
    if (!sleeper.killed) {
      sleeper.kill();
    }
    if (!cleaner.killed) {
      cleaner.kill();
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const [exitCode] = await once(cleaner, "exit");
  assert.equal(exitCode, 0, `stdout: ${cleanupStdout}\nstderr: ${cleanupStderr}`);
  await assert.rejects(fs.access(session));
  await assert.rejects(fs.access(path.dirname(session)));
});

test("removes update caches, failed siblings, and older adjacent portable installs", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bellwright-update-cleanup-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "user-data");
  const installParent = path.join(root, "programs");
  const installDir = await makePackagedFolder(installParent, "BellwrightModLauncher", "0.5.10");
  const staleNew = await makePackagedFolder(
    installParent,
    "BellwrightModLauncher.new-20260716231851080",
    "0.5.8"
  );
  const staleOldStyle = await makePackagedFolder(
    installParent,
    "BellwrightModLauncher-v0.5.3-win-x64-portable.old-20260716231950802",
    "0.5.3"
  );
  const oldPortable = await makePackagedFolder(
    installParent,
    "BellwrightModLauncher-v0.5.8-win-x64-portable",
    "0.5.8"
  );
  const newerPortable = await makePackagedFolder(
    installParent,
    "BellwrightModLauncher-v0.6.0-win-x64-portable",
    "0.6.0"
  );
  const unrelated = await makePackagedFolder(installParent, "MyLauncherBackup", "0.5.1");
  await fs.mkdir(path.join(userDataPath, "updates", "0.5.8-session", "extracted"), { recursive: true });
  await fs.writeFile(path.join(userDataPath, "updates", "0.5.8-session", "launcher.zip"), "cache");

  const removed = await cleanupUpdateArtifacts({ userDataPath, installDir, currentVersion: "0.5.10" });

  assert.equal(await fs.stat(installDir).then(() => true), true);
  assert.equal(await fs.stat(newerPortable).then(() => true), true);
  assert.equal(await fs.stat(unrelated).then(() => true), true);
  for (const removedPath of [staleNew, staleOldStyle, oldPortable, path.join(userDataPath, "updates")]) {
    await assert.rejects(fs.access(removedPath));
    assert.ok(removed.includes(removedPath));
  }
});

test("discarding the only update session also removes the empty updates folder", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bellwright-update-session-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = path.join(root, "updates", "session-one");
  await fs.mkdir(session, { recursive: true });
  await fs.writeFile(path.join(session, "download.zip"), "cache");

  await removeUpdateSession(session);

  await assert.rejects(fs.access(path.join(root, "updates")));
});
