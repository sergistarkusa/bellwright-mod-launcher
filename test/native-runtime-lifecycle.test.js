const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeRuntimeManager } = require("../native-runtime");

const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
const nativeRuntime = fs.readFileSync(path.resolve(__dirname, "..", "native-runtime.js"), "utf8");

test("closing the launcher cannot cancel a pending native-runtime injection", () => {
  const launchHandler = main.match(/ipcMain\.handle\("mods:launchGame"[\s\S]*?\n}\);/)?.[0] || "";
  const closeHandler = main.match(/app\.on\("window-all-closed"[\s\S]*?\n}\);/)?.[0] || "";

  assert.match(launchHandler, /keepAliveForGameLaunchUntil = Date\.now\(\) \+ 120000/);
  assert.match(closeHandler, /!lastKnownGameRunning && !waitingForGame/);
});

test("a background launcher exits after Bellwright closes", () => {
  const poller = main.match(/async function pollGameRunning\(\)[\s\S]*?\n}\n\nfunction startGameRunningWatcher/)?.[0] || "";

  assert.match(poller, /!gameRunning && !mainWindow && Date\.now\(\) >= keepAliveForGameLaunchUntil/);
  assert.match(poller, /app\.quit\(\)/);
});

test("starting the launcher again restores its hidden window", () => {
  const secondInstance = main.match(/app\.on\("second-instance"[\s\S]*?\n}\);/)?.[0] || "";

  assert.match(secondInstance, /if \(!mainWindow\) \{\s*createWindow\(\);/);
});

test("loaded native-runtime status identifies the Bellwright process", () => {
  assert.match(nativeRuntime, /loaded in Bellwright PID \$\{gameProcess\.pid\}/);
});

test("trusted native configs are bounded, verified, and staged before injection", () => {
  assert.match(nativeRuntime, /const MAX_CONFIG_BYTES = 4096/);
  assert.match(nativeRuntime, /configStat\.size > MAX_CONFIG_BYTES/);
  assert.match(nativeRuntime, /await fs\.copyFile\(inspection\.configPath, stagedConfig\)/);
  assert.match(nativeRuntime, /Staged native config failed integrity verification/);
  assert.match(nativeRuntime, /await this\.runInjector\(stagedInjector\)/);
  assert.ok(
    nativeRuntime.indexOf("await fs.copyFile(inspection.configPath, stagedConfig)") <
      nativeRuntime.indexOf("await this.runInjector(stagedInjector)")
  );
});

test("native runtime inspection checks the installed Bellwright executable before launch", async (t) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bellwright-native-runtime-"));
  t.after(() => fsPromises.rm(tempRoot, { recursive: true, force: true }));

  const modRoot = path.join(tempRoot, "mod");
  const payloadPath = path.join(modRoot, "payload.dll");
  const gameExecutablePath = path.join(tempRoot, "BellwrightGame-Win64-Shipping.exe");
  const payload = Buffer.from("trusted test payload");
  const unsupportedGame = Buffer.from("unsupported Bellwright build");
  const supportedGame = Buffer.from("supported Bellwright build");
  const otherPayload = Buffer.from("another trusted payload");
  const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

  await fsPromises.mkdir(modRoot, { recursive: true });
  await fsPromises.writeFile(payloadPath, payload);
  await fsPromises.writeFile(gameExecutablePath, unsupportedGame);
  await fsPromises.writeFile(
    path.join(modRoot, "native-runtime.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.native-runtime",
      displayName: "Test Native Runtime",
      publisher: "Test Publisher",
      version: "1.0.0",
      payload: "payload.dll",
      payloadSha256: sha256(payload),
      loadStage: "main-menu"
    })
  );

  const manager = new NativeRuntimeManager({
    userDataPath: path.join(tempRoot, "user-data"),
    bundledInjectorPath: path.join(tempRoot, "injector.exe"),
    gameLogPath: path.join(tempRoot, "Bellwright.log"),
    resolveGameExecutablePath: async () => gameExecutablePath,
    trustedNativeMods: new Map([
      [
        "test.native-runtime",
        {
          publisher: "Test Publisher",
          payloadHashes: new Set([sha256(payload), sha256(otherPayload)]),
          gameHashesByPayload: new Map([
            [sha256(payload), new Set([sha256(supportedGame)])],
            [sha256(otherPayload), new Set([sha256(unsupportedGame)])]
          ])
        }
      ]
    ])
  });

  const inspection = await manager.inspectMod(modRoot, true);

  assert.equal(inspection.phase, "incompatible");
  assert.equal(inspection.label, "Update required");
  assert.match(inspection.message, /^Update required:.*installed Bellwright build/);

  const disabledInspection = await manager.inspectMod(modRoot, false);
  assert.equal(disabledInspection.phase, "disabled");
  assert.equal(disabledInspection.label, "Runtime disabled");
});

test("launcher resolves the installed Bellwright executable for native runtime cards", () => {
  const managerSetup = main.match(/nativeRuntimeManager = new NativeRuntimeManager\(\{[\s\S]*?\n  \}\);/)?.[0] || "";

  assert.match(managerSetup, /resolveGameExecutablePath:\s*async \(\) =>/);
  assert.match(managerSetup, /await getInstallPaths\(\)/);
  assert.match(managerSetup, /BellwrightGame-Win64-Shipping\.exe/);
});

test("trusted native runtime records pair the hotfix game and payload hashes", () => {
  assert.match(nativeRuntime, /a3adc853e56e8a707348027db70ec923909df5a06ab342b8de5f71fca4ea4251/);
  assert.match(nativeRuntime, /456b2347f094a04cc34715dcd3169a6cebd21759cc8563aa94070333d5d26626/);
  assert.match(nativeRuntime, /gameHashesByPayload/);
});
