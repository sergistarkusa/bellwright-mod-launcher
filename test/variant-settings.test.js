const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { applyVariantOption, inspectVariantSettings, normalizeManifest } = require("../variant-settings");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bml-variants-"));
  const file = "Example.pak";
  const variants = { slow: "slow package", fast: "fast package" };
  for (const [id, content] of Object.entries(variants)) {
    const directory = path.join(root, "launcher-variants", id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${file}.variant`), content);
  }
  await fs.writeFile(path.join(root, file), variants.slow);
  await fs.writeFile(path.join(root, "launcher-settings.json"), JSON.stringify({
    schemaVersion: 1,
    groups: [{
      id: "speed",
      label: "Speed",
      description: "Test speed",
      defaultOption: "slow",
      files: [file],
      options: Object.entries(variants).map(([id, content]) => ({
        id,
        label: id,
        directory: `launcher-variants/${id}`,
        hashes: { [file]: hash(content) }
      }))
    }]
  }));
  return { root, file };
}

test("inspects the applied package and desired selection", async (t) => {
  const { root } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = await inspectVariantSettings(root, { speed: "fast" });
  assert.equal(settings.groups[0].selectedOption, "fast");
  assert.equal(settings.groups[0].appliedOption, "slow");
  assert.equal(settings.groups[0].inSync, false);
});

test("atomically applies and verifies a variant package", async (t) => {
  const { root, file } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = await applyVariantOption(root, "speed", "fast");
  assert.equal(await fs.readFile(path.join(root, file), "utf8"), "fast package");
  assert.equal(settings.groups[0].appliedOption, "fast");
  assert.equal(settings.groups[0].inSync, true);
});

test("rejects traversal and package types outside the allowlist", () => {
  assert.throws(() => normalizeManifest({
    schemaVersion: 1,
    groups: [{
      id: "speed",
      defaultOption: "bad",
      files: ["../payload.dll"],
      options: [{ id: "bad", directory: "../outside", hashes: {} }]
    }]
  }), /unsafe package file name/);
});

test("accepts a bounded native runtime config variant", () => {
  const manifest = normalizeManifest({
    schemaVersion: 1,
    groups: [{
      id: "frequency",
      defaultOption: "standard",
      files: ["SettlementImmigration.cfg"],
      options: [{
        id: "standard",
        directory: "launcher-variants/standard",
        hashes: { "SettlementImmigration.cfg": hash("profile=4\n") }
      }]
    }]
  });
  assert.deepEqual(manifest.groups[0].files, ["SettlementImmigration.cfg"]);
});

test("does not replace the live package when a variant hash is damaged", async (t) => {
  const { root, file } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "launcher-variants", "fast", `${file}.variant`), "tampered");
  await assert.rejects(() => applyVariantOption(root, "speed", "fast"), /missing or damaged/);
  assert.equal(await fs.readFile(path.join(root, file), "utf8"), "slow package");
});
