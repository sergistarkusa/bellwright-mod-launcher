const fs = require("node:fs/promises");
const path = require("node:path");

const UPDATE_ARTIFACT_SUFFIX = /\.(?:new|old)-\d{17}$/i;
const VERSIONED_PORTABLE_FOLDER = /^BellwrightModLauncher-v(\d+\.\d+\.\d+)-win-x64-portable$/i;

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function compareVersions(left, right) {
  const parse = (value) => normalizeVersion(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackagedVersion(folderPath) {
  try {
    const packagePath = path.join(folderPath, "resources", "app", "package.json");
    const packageInfo = JSON.parse(await fs.readFile(packagePath, "utf8"));
    return normalizeVersion(packageInfo.version);
  } catch {
    return "";
  }
}

function isKnownUpdateArtifact(name, installLeaf) {
  if (!UPDATE_ARTIFACT_SUFFIX.test(name)) {
    return false;
  }
  const baseName = name.replace(UPDATE_ARTIFACT_SUFFIX, "");
  return (
    baseName.toLowerCase() === installLeaf.toLowerCase() ||
    baseName.toLowerCase().startsWith("bellwrightmodlauncher")
  );
}

async function removeUpdateSession(updateRoot) {
  if (!updateRoot) {
    return;
  }
  const sessionRoot = path.resolve(updateRoot);
  const updatesRoot = path.dirname(sessionRoot);
  await fs.rm(sessionRoot, { recursive: true, force: true });
  try {
    const remaining = await fs.readdir(updatesRoot);
    if (remaining.length === 0) {
      await fs.rmdir(updatesRoot);
    }
  } catch {
    // The parent either still contains another session or was already removed.
  }
}

async function cleanupUpdateArtifacts({ userDataPath, installDir, currentVersion }) {
  const removed = [];
  const updatesRoot = path.join(path.resolve(userDataPath), "updates");
  if (await exists(updatesRoot)) {
    await fs.rm(updatesRoot, { recursive: true, force: true });
    removed.push(updatesRoot);
  }

  const resolvedInstall = path.resolve(installDir);
  const installParent = path.dirname(resolvedInstall);
  const installLeaf = path.basename(resolvedInstall);
  let entries = [];
  try {
    entries = await fs.readdir(installParent, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(installParent, entry.name);
    if (path.resolve(candidate) === resolvedInstall) {
      continue;
    }

    let shouldRemove = isKnownUpdateArtifact(entry.name, installLeaf);
    const versionedMatch = entry.name.match(VERSIONED_PORTABLE_FOLDER);
    if (!shouldRemove && installLeaf.toLowerCase() === "bellwrightmodlauncher" && versionedMatch) {
      const packagedVersion = await readPackagedVersion(candidate);
      shouldRemove = Boolean(
        packagedVersion &&
        compareVersions(packagedVersion, currentVersion) < 0 &&
        await exists(path.join(candidate, "BellwrightModLauncher.exe"))
      );
    }

    if (shouldRemove) {
      await fs.rm(candidate, { recursive: true, force: true });
      removed.push(candidate);
    }
  }
  return removed;
}

module.exports = {
  cleanupUpdateArtifacts,
  compareVersions,
  isKnownUpdateArtifact,
  removeUpdateSession
};
