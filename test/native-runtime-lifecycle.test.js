const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeRuntimeManager } = require("../native-runtime");
const { canonicalRuntimeManifest } = require("../native-signature");

const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
const nativeRuntime = fs.readFileSync(path.resolve(__dirname, "..", "native-runtime.js"), "utf8");

function createMinimalX64Dll(marker = "") {
  const buffer = Buffer.alloc(0x400);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  const coff = 0x84;
  buffer.writeUInt16LE(0x8664, coff);
  buffer.writeUInt16LE(1, coff + 2);
  buffer.writeUInt16LE(0xf0, coff + 16);
  buffer.writeUInt16LE(0x2022, coff + 18);
  const optional = coff + 20;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(16, optional + 108);
  const section = optional + 0xf0;
  buffer.write(".rdata", section, "ascii");
  buffer.writeUInt32LE(0x200, section + 8);
  buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0x200, section + 16);
  buffer.writeUInt32LE(0x200, section + 20);
  if (marker) {
    buffer.write(marker, 0x220, "utf8");
  }
  return buffer;
}

test("closing the launcher cannot cancel a pending native-runtime injection", () => {
  const launchHandler = main.match(/ipcMain\.handle\("mods:launchGame"[\s\S]*?\n}\);/)?.[0] || "";
  const closeHandler = main.match(/app\.on\("window-all-closed"[\s\S]*?\n}\);/)?.[0] || "";

  assert.match(launchHandler, /keepAliveForGameLaunchUntil = Date\.now\(\) \+ 120000/);
  assert.match(closeHandler, /!lastKnownGameRunning && !waitingForGame/);
});

test("a background launcher exits after Bellwright closes", () => {
  const poller = main.match(/async function pollGameRunning\(\)[\s\S]*?\r?\n}\r?\n\r?\nfunction startGameRunningWatcher/)?.[0] || "";

  assert.match(poller, /!gameRunning && !mainWindow && Date\.now\(\) >= keepAliveForGameLaunchUntil/);
  assert.match(poller, /app\.quit\(\)/);
});

test("starting the launcher again restores its hidden window", () => {
  const secondInstance = main.match(/app\.on\("second-instance"[\s\S]*?\n}\);/)?.[0] || "";

  assert.match(secondInstance, /if \(!mainWindow\) \{\s*createWindow\(\);/);
});

test("loaded native-runtime status identifies the Bellwright process", () => {
  assert.match(nativeRuntime, /loaded in Bellwright PID \$\{gameProcess\.pid\}/);
  assert.match(main, /ProcessName -eq 'BellwrightGame-Win64-Shipping'/);
});

test("native payloads are injected directly from their mod folders without staging copies", () => {
  assert.match(nativeRuntime, /const MAX_CONFIG_BYTES = 64 \* 1024/);
  assert.match(nativeRuntime, /configStat\.size > MAX_CONFIG_BYTES/);
  assert.match(nativeRuntime, /await this\.runInjector\(inspection\.payloadPath, targetPid\)/);
  assert.doesNotMatch(nativeRuntime, /stageAndInject|STAGED_PAYLOAD_NAME|fs\.copyFile\(inspection\.payloadPath/);
});

test("native runtime inspection checks the installed Bellwright executable before launch", async (t) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bellwright-native-runtime-"));
  t.after(() => fsPromises.rm(tempRoot, { recursive: true, force: true }));

  const modRoot = path.join(tempRoot, "mod");
  const payloadPath = path.join(modRoot, "payload.dll");
  const gameExecutablePath = path.join(tempRoot, "BellwrightGame-Win64-Shipping.exe");
  const payload = createMinimalX64Dll("trusted test payload");
  const unsupportedGame = Buffer.from("unsupported Bellwright build");
  const supportedGame = Buffer.from("supported Bellwright build");
  const otherPayload = createMinimalX64Dll("another trusted payload");
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
  assert.match(inspection.message, /verified native mod.*installed Bellwright build/);

  const disabledInspection = await manager.inspectMod(modRoot, false);
  assert.equal(disabledInspection.phase, "disabled");
  assert.equal(disabledInspection.label, "Verified native");
});

test("a pinned Ed25519 key accepts new signed payloads without a launcher hash update", async (t) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bellwright-signed-native-"));
  t.after(() => fsPromises.rm(tempRoot, { recursive: true, force: true }));
  const modRoot = path.join(tempRoot, "mod");
  const payloadPath = path.join(modRoot, "payload.dll");
  const gamePath = path.join(tempRoot, "BellwrightGame-Win64-Shipping.exe");
  const manifestPath = path.join(modRoot, "native-runtime.json");
  const payload = createMinimalX64Dll("new payload unknown to this launcher build");
  const game = Buffer.from("supported signed Bellwright build");
  const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = "test-signing-key";

  await fsPromises.mkdir(modRoot, { recursive: true });
  await fsPromises.writeFile(payloadPath, payload);
  await fsPromises.writeFile(gamePath, game);
  const manifest = {
    schemaVersion: 1,
    id: "test.signed-native-runtime",
    displayName: "Signed Native Runtime",
    publisher: "Test Publisher",
    version: "2.0.0",
    payload: "payload.dll",
    payloadSha256: sha256(payload),
    loadStage: "main-menu",
    supportedGameSha256: [sha256(game)]
  };
  manifest.signature = {
    algorithm: "ed25519",
    keyId,
    value: crypto.sign(null, canonicalRuntimeManifest(manifest), privateKey).toString("base64")
  };
  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));

  const manager = new NativeRuntimeManager({
    userDataPath: path.join(tempRoot, "user-data"),
    bundledInjectorPath: path.join(tempRoot, "injector.exe"),
    gameLogPath: path.join(tempRoot, "Bellwright.log"),
    resolveGameExecutablePath: async () => gamePath,
    trustedNativeMods: new Map([[manifest.id, {
      publisher: manifest.publisher,
      payloadHashes: new Set(),
      gameHashesByPayload: new Map(),
      publicKeys: new Map([[keyId, publicKey]])
    }]])
  });

  const inspection = await manager.inspectMod(modRoot, true);
  assert.equal(inspection.phase, "ready");
  assert.deepEqual(inspection.verifiedGameHashes, [sha256(game)]);

  manifest.supportedGameSha256 = [sha256(Buffer.from("tampered game"))];
  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));
  const tampered = await manager.inspectMod(modRoot, true);
  assert.equal(tampered.phase, "approval-required");
  assert.equal(tampered.verified, false);
  assert.equal(tampered.signatureStatus, "invalid");
});

test("an unsigned Workshop-style native DLL is auto-detected and can be approved without a launcher allowlist", async (t) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bellwright-community-native-"));
  t.after(() => fsPromises.rm(tempRoot, { recursive: true, force: true }));
  const modRoot = path.join(tempRoot, "3760000000");
  const nativeRoot = path.join(modRoot, "native");
  const payloadPath = path.join(nativeRoot, "CommunityMod.dll");
  await fsPromises.mkdir(nativeRoot, { recursive: true });
  await fsPromises.writeFile(payloadPath, createMinimalX64Dll("community-v1"));
  await fsPromises.writeFile(path.join(modRoot, "modinfo.json"), JSON.stringify({
    title: "Community Mod",
    author: "Workshop Author",
    steamId: 3760000000
  }));

  const manager = new NativeRuntimeManager({
    userDataPath: path.join(tempRoot, "user-data"),
    bundledInjectorPath: path.join(tempRoot, "injector.exe"),
    gameLogPath: path.join(tempRoot, "Bellwright.log"),
    trustedNativeMods: new Map()
  });
  const first = await manager.inspectMod(modRoot, true);
  assert.equal(first.phase, "approval-required");
  assert.equal(first.payload, "native/CommunityMod.dll");
  assert.equal(first.identity, "workshop:3760000000");
  assert.equal(first.verified, false);

  await manager.approveNativeMod(first.identity, "version", first.actualHash);
  const approved = await manager.inspectMod(modRoot, true);
  assert.equal(approved.phase, "ready");
  assert.equal(approved.approvalMode, "version");

  await new Promise((resolve) => setTimeout(resolve, 10));
  await fsPromises.writeFile(payloadPath, createMinimalX64Dll("community-v2"));
  const updated = await manager.inspectMod(modRoot, true);
  assert.equal(updated.phase, "approval-required");
});

test("a local mod cannot inherit Workshop trust by spoofing steamId in modinfo", async (t) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bellwright-local-native-"));
  t.after(() => fsPromises.rm(tempRoot, { recursive: true, force: true }));
  const workshopRoot = path.join(tempRoot, "3760000000");
  const localRoot = path.join(tempRoot, "CopiedCommunityMod");
  for (const modRoot of [workshopRoot, localRoot]) {
    await fsPromises.mkdir(path.join(modRoot, "native"), { recursive: true });
    await fsPromises.writeFile(path.join(modRoot, "native", "CommunityMod.dll"), createMinimalX64Dll("same-payload"));
    await fsPromises.writeFile(path.join(modRoot, "modinfo.json"), JSON.stringify({
      title: "Community Mod",
      steamId: 3760000000
    }));
  }

  const manager = new NativeRuntimeManager({
    userDataPath: path.join(tempRoot, "user-data"),
    bundledInjectorPath: path.join(tempRoot, "injector.exe"),
    gameLogPath: path.join(tempRoot, "Bellwright.log"),
    trustedNativeMods: new Map()
  });
  const workshop = await manager.inspectMod(workshopRoot, true);
  await manager.approveNativeMod(workshop.identity, "item", workshop.actualHash);
  const local = await manager.inspectMod(localRoot, true);

  assert.equal(workshop.identity, "workshop:3760000000");
  assert.equal(local.identity, "local:copiedcommunitymod");
  assert.equal(local.phase, "approval-required");
  assert.equal(local.approved, false);
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
  assert.match(nativeRuntime, /excelsiorone\.settlement-immigration/);
  assert.match(nativeRuntime, /publisher: "ExcelsiorOne"/);
  assert.match(nativeRuntime, /gameHashesByPayload/);
});
