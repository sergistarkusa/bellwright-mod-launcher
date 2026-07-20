const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { discoverNativePayload, parsePortableExecutable } = require("../native-discovery");

function createX64Dll({ imports = [], entryExport = "" } = {}) {
  const buffer = Buffer.alloc(0x700);
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
  buffer.writeUInt32LE(0x500, section + 8);
  buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0x500, section + 16);
  buffer.writeUInt32LE(0x200, section + 20);

  if (imports.length) {
    buffer.writeUInt32LE(0x1000, optional + 120);
    buffer.writeUInt32LE((imports.length + 1) * 20, optional + 124);
    let nameOffset = 0x200 + (imports.length + 1) * 20;
    imports.forEach((name, index) => {
      buffer.writeUInt32LE(0x1000 + (nameOffset - 0x200), 0x200 + index * 20 + 12);
      buffer.write(`${name}\0`, nameOffset, "ascii");
      nameOffset += Buffer.byteLength(name, "ascii") + 1;
    });
  }

  if (entryExport) {
    buffer.writeUInt32LE(0x1200, optional + 112);
    buffer.writeUInt32LE(0x80, optional + 116);
    const exportOffset = 0x400;
    buffer.writeUInt32LE(1, exportOffset + 24);
    buffer.writeUInt32LE(0x1240, exportOffset + 32);
    buffer.writeUInt32LE(0x1250, 0x440);
    buffer.write(`${entryExport}\0`, 0x450, "ascii");
  }
  return buffer;
}

test("PE inspection identifies x64 DLL imports and the optional Bellwright entry export", () => {
  const inspection = parsePortableExecutable(createX64Dll({
    imports: ["Helper.dll", "KERNEL32.dll"],
    entryExport: "BellwrightModEntry"
  }));
  assert.equal(inspection.isX64Dll, true);
  assert.deepEqual(inspection.imports, ["helper.dll", "kernel32.dll"]);
  assert.ok(inspection.exports.includes("bellwrightmodentry"));
});

test("automatic discovery loads the dependency graph root instead of helper DLLs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bellwright-native-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nativeRoot = path.join(root, "native");
  await fs.mkdir(nativeRoot, { recursive: true });
  await fs.writeFile(path.join(nativeRoot, "CommunityMod.dll"), createX64Dll({ imports: ["Helper.dll"] }));
  await fs.writeFile(path.join(nativeRoot, "Helper.dll"), createX64Dll());

  const discovery = await discoverNativePayload(root, ["Community Mod"]);
  assert.equal(discovery.reason, "dependency-root");
  assert.equal(discovery.selected.relativePath, "native/CommunityMod.dll");
});

test("ambiguous independent DLLs are reported for one-time user selection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bellwright-native-ambiguous-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nativeRoot = path.join(root, "native");
  await fs.mkdir(nativeRoot, { recursive: true });
  await fs.writeFile(path.join(nativeRoot, "First.dll"), createX64Dll());
  await fs.writeFile(path.join(nativeRoot, "Second.dll"), createX64Dll());

  const discovery = await discoverNativePayload(root, []);
  assert.equal(discovery.reason, "ambiguous");
  assert.equal(discovery.selected, null);
  assert.deepEqual(discovery.candidates.map((candidate) => candidate.relativePath).sort(), [
    "native/First.dll",
    "native/Second.dll"
  ]);
});
