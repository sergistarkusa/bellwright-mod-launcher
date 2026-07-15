const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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
