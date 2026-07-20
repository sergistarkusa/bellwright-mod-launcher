const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const handoff = path.join(root, "runtime", "BellwrightUpdateHandoff.exe");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);

function waitForFile(filePath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

function peMetadata(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ");
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", peOffset, peOffset + 4), "PE\0\0");
  return {
    machine: bytes.readUInt16LE(peOffset + 4),
    subsystem: bytes.readUInt16LE(peOffset + 24 + 68)
  };
}

test("update handoff is an x64 GUI executable", { skip: process.platform !== "win32" }, () => {
  assert.equal(fs.existsSync(handoff), true, "Build runtime/BellwrightUpdateHandoff.exe first");
  assert.deepEqual(peMetadata(handoff), { machine: 0x8664, subsystem: 2 });
});

test("update handoff preserves complex child-process arguments", { skip: process.platform !== "win32" }, () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bellwright handoff "));
  const marker = path.join(testRoot, "argument marker.txt");
  const log = path.join(testRoot, "handoff log.txt");
  const expected = ["value with spaces", "quote\"value", "trailing\\"];
  const command = "require('node:fs').writeFileSync(process.env.BELLWRIGHT_HANDOFF_MARKER, JSON.stringify(process.argv.slice(1)))";
  try {
    const result = spawnSync(
      handoff,
      ["--log", log, process.execPath, "-e", command, ...expected],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, BELLWRIGHT_HANDOFF_MARKER: marker }
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    waitForFile(marker);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), expected);
    assert.match(fs.readFileSync(log, "utf8"), /GUI-safe handoff started updater process \d+/);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("update handoff starts hidden PowerShell without inherited output handles", { skip: process.platform !== "win32" }, () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bellwright powershell handoff "));
  const marker = path.join(testRoot, "powershell marker.txt");
  const log = path.join(testRoot, "handoff log.txt");
  const command = "[System.IO.File]::WriteAllText($env:BELLWRIGHT_HANDOFF_MARKER, 'powershell-ok')";
  try {
    const result = spawnSync(
      handoff,
      ["--log", log, powershell, "-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, BELLWRIGHT_HANDOFF_MARKER: marker }
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    waitForFile(marker);
    assert.equal(fs.readFileSync(marker, "utf8"), "powershell-ok");
    assert.match(fs.readFileSync(log, "utf8"), /GUI-safe handoff started updater process \d+/);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
