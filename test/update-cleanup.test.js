const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cleanupUpdateArtifacts,
  isKnownUpdateArtifact,
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

test("removes update caches, failed siblings, and older adjacent portable installs", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bellwright-update-cleanup-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "user-data");
  const installParent = path.join(root, "programs");
  const installDir = await makePackagedFolder(installParent, "BellwrightModLauncher", "0.5.9");
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

  const removed = await cleanupUpdateArtifacts({ userDataPath, installDir, currentVersion: "0.5.9" });

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
