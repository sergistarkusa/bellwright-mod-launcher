const fs = require("node:fs/promises");
const path = require("node:path");

const UPDATE_ARTIFACT_SUFFIX = /\.(?:new|old)-\d{17}$/i;
const VERSIONED_PORTABLE_FOLDER = /^BellwrightModLauncher-v(\d+\.\d+\.\d+)-win-x64-portable$/i;
const RETRYABLE_REMOVAL_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
const REMOVE_ATTEMPTS = 4;
const REMOVE_RETRY_DELAY_MS = 250;

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

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function removeTreeWithRetry(
  targetPath,
  {
    rm = fs.rm.bind(fs),
    waitForRetry = wait,
    attempts = REMOVE_ATTEMPTS,
    retryDelayMs = REMOVE_RETRY_DELAY_MS
  } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: retryDelayMs
      });
      return;
    } catch (error) {
      if (!RETRYABLE_REMOVAL_CODES.has(error?.code) || attempt === attempts) {
        throw error;
      }
      await waitForRetry(retryDelayMs * attempt);
    }
  }
}

function findContainingUpdateSession(userDataPath, executablePath) {
  if (!userDataPath || !executablePath) {
    return null;
  }
  const updatesRoot = path.join(path.resolve(userDataPath), "updates");
  const relative = path.relative(updatesRoot, path.resolve(executablePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  const [sessionName] = relative.split(path.sep);
  return sessionName ? path.join(updatesRoot, sessionName) : null;
}

function buildPostExitCleanupCommand() {
  return [
    "& {",
    "$launcherProcessId = [int]$env:BELLWRIGHT_CLEANUP_PROCESS_ID",
    "$target = [string]$env:BELLWRIGHT_CLEANUP_TARGET",
    "if ($launcherProcessId -le 0 -or [string]::IsNullOrWhiteSpace($target)) { exit 2 }",
    "Wait-Process -Id $launcherProcessId -ErrorAction SilentlyContinue",
    "for ($attempt = 1; $attempt -le 80; $attempt++) {",
    "try {",
    "if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop }",
    "if (-not (Test-Path -LiteralPath $target)) {",
    "$parent = Split-Path -Parent $target",
    "if ((Test-Path -LiteralPath $parent) -and @(Get-ChildItem -LiteralPath $parent -Force).Count -eq 0) {",
    "Remove-Item -LiteralPath $parent -Force -ErrorAction Stop",
    "}",
    "exit 0",
    "}",
    "} catch {}",
    "Start-Sleep -Milliseconds 250",
    "}",
    "exit 1",
    "}"
  ].join("\n");
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
  await removeTreeWithRetry(sessionRoot);
  try {
    const remaining = await fs.readdir(updatesRoot);
    if (remaining.length === 0) {
      await fs.rmdir(updatesRoot);
    }
  } catch {
    // The parent either still contains another session or was already removed.
  }
}

async function cleanupUpdateArtifacts({ userDataPath, installDir, currentVersion, currentExecutablePath = "" }) {
  const removed = [];
  const updatesRoot = path.join(path.resolve(userDataPath), "updates");
  const activeUpdateSession = findContainingUpdateSession(userDataPath, currentExecutablePath);
  if (await exists(updatesRoot)) {
    const updateEntries = await fs.readdir(updatesRoot, { withFileTypes: true });
    for (const entry of updateEntries) {
      const candidate = path.join(updatesRoot, entry.name);
      if (activeUpdateSession && path.resolve(candidate) === path.resolve(activeUpdateSession)) {
        continue;
      }
      await removeTreeWithRetry(candidate);
      removed.push(candidate);
    }
    try {
      const remaining = await fs.readdir(updatesRoot);
      if (remaining.length === 0) {
        await fs.rmdir(updatesRoot);
        removed.push(updatesRoot);
      }
    } catch {
      // Another process may have finished cleanup or created a new update session.
    }
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
      await removeTreeWithRetry(candidate);
      removed.push(candidate);
    }
  }
  return removed;
}

module.exports = {
  buildPostExitCleanupCommand,
  cleanupUpdateArtifacts,
  compareVersions,
  findContainingUpdateSession,
  isKnownUpdateArtifact,
  removeTreeWithRetry,
  removeUpdateSession
};
