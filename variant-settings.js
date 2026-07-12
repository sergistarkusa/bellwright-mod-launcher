const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const MANIFEST_FILE = "launcher-settings.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, fallback = "", maxLength = 240) {
  const result = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return result.slice(0, maxLength) || fallback;
}

function assertSafeRelativeDirectory(value) {
  const directory = String(value || "").replace(/\\/g, "/");
  if (!directory || path.posix.isAbsolute(directory) || directory.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("A launcher option contains an unsafe variant directory.");
  }
  return directory;
}

function assertSafeFileName(value) {
  const file = String(value || "");
  if (!file || path.basename(file) !== file || !/\.(pak|sig|ucas|utoc)$/i.test(file)) {
    throw new Error("A launcher setting contains an unsafe package file name.");
  }
  return file;
}

function normalizeSelectionMap(value) {
  if (!isObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([groupId, optionId]) => SAFE_ID_PATTERN.test(groupId) && SAFE_ID_PATTERN.test(String(optionId || "")))
      .slice(0, 32)
      .map(([groupId, optionId]) => [groupId, String(optionId)])
  );
}

function normalizeManifest(raw) {
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.groups) || !raw.groups.length || raw.groups.length > 16) {
    throw new Error("Unsupported launcher-settings.json schema.");
  }

  const groupIds = new Set();
  const groups = raw.groups.map((rawGroup) => {
    const id = String(rawGroup?.id || "");
    if (!SAFE_ID_PATTERN.test(id) || groupIds.has(id)) {
      throw new Error("Launcher settings contain an invalid or duplicate group ID.");
    }
    groupIds.add(id);
    const files = Array.isArray(rawGroup.files) ? rawGroup.files.map(assertSafeFileName) : [];
    if (!files.length || files.length > 32 || new Set(files).size !== files.length) {
      throw new Error(`Launcher setting group "${id}" has an invalid package file list.`);
    }

    const optionIds = new Set();
    const options = (Array.isArray(rawGroup.options) ? rawGroup.options : []).map((rawOption) => {
      const optionId = String(rawOption?.id || "");
      if (!SAFE_ID_PATTERN.test(optionId) || optionIds.has(optionId)) {
        throw new Error(`Launcher setting group "${id}" has an invalid or duplicate option ID.`);
      }
      optionIds.add(optionId);
      const hashes = isObject(rawOption.hashes) ? rawOption.hashes : {};
      const normalizedHashes = {};
      for (const file of files) {
        const hash = String(hashes[file] || "").toLowerCase();
        if (!HASH_PATTERN.test(hash)) {
          throw new Error(`Launcher option "${optionId}" is missing a valid SHA-256 hash for ${file}.`);
        }
        normalizedHashes[file] = hash;
      }
      return {
        id: optionId,
        label: cleanText(rawOption.label, optionId, 100),
        description: cleanText(rawOption.description, "", 280),
        directory: assertSafeRelativeDirectory(rawOption.directory),
        hashes: normalizedHashes
      };
    });
    if (!options.length || options.length > 32) {
      throw new Error(`Launcher setting group "${id}" has no valid options.`);
    }
    const defaultOption = String(rawGroup.defaultOption || "");
    if (!optionIds.has(defaultOption)) {
      throw new Error(`Launcher setting group "${id}" has an invalid default option.`);
    }
    return {
      id,
      label: cleanText(rawGroup.label, id, 120),
      description: cleanText(rawGroup.description, "", 400),
      defaultOption,
      files,
      options
    };
  });
  return { schemaVersion: 1, groups };
}

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function readManifest(modFolder) {
  let raw;
  try {
    raw = JSON.parse((await fs.readFile(path.join(modFolder, MANIFEST_FILE), "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Cannot read ${MANIFEST_FILE}: ${error.message}`);
  }
  return normalizeManifest(raw);
}

async function detectAppliedOption(modFolder, group) {
  const currentHashes = {};
  try {
    for (const file of group.files) {
      currentHashes[file] = await sha256(path.join(modFolder, file));
    }
  } catch {
    return null;
  }
  return group.options.find((option) => group.files.every((file) => currentHashes[file] === option.hashes[file]))?.id || null;
}

async function inspectVariantSettings(modFolder, selections = {}) {
  const manifest = await readManifest(modFolder);
  if (!manifest) {
    return null;
  }
  const normalizedSelections = normalizeSelectionMap(selections);
  const groups = [];
  for (const group of manifest.groups) {
    const selectedOption = group.options.some((option) => option.id === normalizedSelections[group.id])
      ? normalizedSelections[group.id]
      : group.defaultOption;
    const appliedOption = await detectAppliedOption(modFolder, group);
    groups.push({
      id: group.id,
      label: group.label,
      description: group.description,
      defaultOption: group.defaultOption,
      selectedOption,
      appliedOption,
      inSync: selectedOption === appliedOption,
      options: group.options.map(({ id, label, description }) => ({ id, label, description }))
    });
  }
  return { schemaVersion: 1, groups };
}

function assertInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Variant package path escapes the mod folder.");
  }
}

async function applyVariantOption(modFolder, groupId, optionId) {
  const manifest = await readManifest(modFolder);
  if (!manifest) {
    throw new Error(`This mod does not provide ${MANIFEST_FILE}.`);
  }
  const group = manifest.groups.find((candidate) => candidate.id === groupId);
  const option = group?.options.find((candidate) => candidate.id === optionId);
  if (!group || !option) {
    throw new Error("Unknown mod setting or option.");
  }

  const variantRoot = path.join(modFolder, ...option.directory.split("/"));
  assertInside(modFolder, variantRoot);
  const transaction = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const staged = [];
  const backups = [];
  try {
    for (const file of group.files) {
      const source = path.join(variantRoot, `${file}.variant`);
      const target = path.join(modFolder, file);
      const temp = path.join(modFolder, `.${file}.${transaction}.next`);
      assertInside(variantRoot, source);
      assertInside(modFolder, target);
      if ((await sha256(source)) !== option.hashes[file]) {
        throw new Error(`Variant package ${file} is missing or damaged.`);
      }
      await fs.copyFile(source, temp);
      if ((await sha256(temp)) !== option.hashes[file]) {
        throw new Error(`Failed to verify staged package ${file}.`);
      }
      staged.push({ file, target, temp });
    }

    for (const entry of staged) {
      const backup = path.join(modFolder, `.${entry.file}.${transaction}.backup`);
      try {
        await fs.rename(entry.target, backup);
        backups.push({ target: entry.target, backup });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      await fs.rename(entry.temp, entry.target);
    }
    for (const { backup } of backups) {
      await fs.rm(backup, { force: true });
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      await fs.rm(entry.temp, { force: true }).catch(() => {});
    }
    for (const { target, backup } of [...backups].reverse()) {
      await fs.rm(target, { force: true }).catch(() => {});
      await fs.rename(backup, target).catch(() => {});
    }
    throw error;
  }
  return inspectVariantSettings(modFolder, { [groupId]: optionId });
}

module.exports = {
  MANIFEST_FILE,
  applyVariantOption,
  inspectVariantSettings,
  normalizeManifest,
  normalizeSelectionMap,
  sha256
};
