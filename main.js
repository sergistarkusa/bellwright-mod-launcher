const { app, BrowserWindow, ipcMain, shell, screen, dialog, clipboard } = require("electron");
const fsNative = require("fs");
const fs = require("fs/promises");
const path = require("path");
const childProcess = require("child_process");
const https = require("https");
const zlib = require("zlib");
const packageInfo = require("./package.json");
const { NativeRuntimeManager } = require("./native-runtime");
const { applyVariantOption, inspectVariantSettings, normalizeSelectionMap } = require("./variant-settings");

const GAME_APP_ID = "1812450";
const DEFAULT_STEAM_ROOT = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam");
const DEFAULT_GAME_ROOT = path.join(DEFAULT_STEAM_ROOT, "steamapps", "common", "Bellwright", "Bellwright");
const DISABLED_FOLDER_NAME = "_disabled_by_bellwright_launcher";
const LEGACY_DISABLED_FOLDER_NAME = "_disabled_for_runtime_scoped_test";
const MOD_LOAD_ORDER_FILE = "modloadorder.json";
const LOAD_ORDER_BASE_PRIORITY = 100000;
const MAX_CONFLICT_ASSETS = 80;
const GAME_PROCESS_NAMES = new Set([
  "Bellwright.exe",
  "BellwrightGame.exe",
  "BellwrightGame-Win64-Shipping.exe",
  "Bellwright-Win64-Shipping.exe"
]);
const TOOLTIP_WIDTH = 360;
const TOOLTIP_HEIGHT = 392;
const TOOLTIP_MARGIN = 10;
const DONATE_URL = "https://ko-fi.com/excelsiorone";
const DISCORD_URL = "https://discord.gg/Nnqt8S2r7n";
const GITHUB_OWNER = "sergistarkusa";
const GITHUB_REPO = "bellwright-mod-launcher";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
const UPDATE_EXE_NAME = "BellwrightModLauncher.exe";
const UPDATE_ASSET_PATTERN = /win-x64-portable\.zip$/i;
const PRESET_SHARE_PREFIX = "BWL1:";
const MAX_SHARE_CODE_LENGTH = 100000;
const MAX_SHARED_PRESET_BYTES = 1024 * 1024;
const MAX_SHARED_MODS = 500;

let mainWindow;
let tooltipWindow;
let tooltipReady = false;
let pendingTooltipMod = null;
let cachedInstallPaths = null;
let updateInProgress = false;
let gameRunningPollTimer = null;
let gameRunningPollInFlight = false;
let lastKnownGameRunning = null;
let nativeRuntimeManager = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#101111",
    title: "Bellwright Mod Launcher",
    frame: false,
    hasShadow: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[launcher] renderer loaded");
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`[launcher] renderer failed to load: ${errorCode} ${errorDescription}`);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[launcher] renderer process gone: ${details.reason}`);
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on("move", hideTooltipWindow);
  mainWindow.on("resize", hideTooltipWindow);
  mainWindow.on("minimize", hideTooltipWindow);
  mainWindow.on("hide", hideTooltipWindow);
  mainWindow.on("blur", hideTooltipWindow);
  mainWindow.on("closed", () => {
    destroyTooltipWindow();
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function createTooltipWindow() {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    return tooltipWindow;
  }

  tooltipReady = false;
  tooltipWindow = new BrowserWindow({
    width: TOOLTIP_WIDTH,
    height: TOOLTIP_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  tooltipWindow.setIgnoreMouseEvents(true);
  tooltipWindow.on("closed", () => {
    tooltipWindow = null;
    tooltipReady = false;
    pendingTooltipMod = null;
  });
  tooltipWindow.webContents.on("did-finish-load", () => {
    tooltipReady = true;
    if (pendingTooltipMod) {
      tooltipWindow.webContents.send("tooltip:setMod", pendingTooltipMod);
    }
  });
  tooltipWindow.loadFile(path.join(__dirname, "renderer", "tooltip.html"));
  return tooltipWindow;
}

function destroyTooltipWindow() {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    tooltipWindow.destroy();
  }
  tooltipWindow = null;
  tooltipReady = false;
  pendingTooltipMod = null;
}

function hideTooltipWindow() {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    tooltipWindow.hide();
  }
}

function showTooltipWindow(payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
    return false;
  }
  if (!payload?.mod || !payload?.anchorRect) {
    return false;
  }

  const tooltip = createTooltipWindow();
  pendingTooltipMod = payload.mod;
  tooltip.setBounds(getTooltipBounds(payload.anchorRect), false);
  if (tooltipReady) {
    tooltip.webContents.send("tooltip:setMod", pendingTooltipMod);
  }
  tooltip.showInactive();
  return true;
}

function getTooltipBounds(anchorRect) {
  const windowBounds = mainWindow.getBounds();
  const contentBounds = mainWindow.getContentBounds();
  const display = screen.getDisplayMatching(windowBounds);
  const workArea = display.workArea;
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;

  const rightX = windowBounds.x + windowBounds.width + TOOLTIP_MARGIN;
  const leftX = windowBounds.x - TOOLTIP_WIDTH - TOOLTIP_MARGIN;
  const rightFits = rightX + TOOLTIP_WIDTH <= workRight;
  const leftFits = leftX >= workArea.x;
  let x;

  if (rightFits) {
    x = rightX;
  } else if (leftFits) {
    x = leftX;
  } else {
    const rightSpace = workRight - windowBounds.x - windowBounds.width;
    const leftSpace = windowBounds.x - workArea.x;
    x = rightSpace >= leftSpace ? workRight - TOOLTIP_WIDTH - TOOLTIP_MARGIN : workArea.x + TOOLTIP_MARGIN;
  }

  const anchorTop = contentBounds.y + Number(anchorRect.top || 0);
  const anchorHeight = Number(anchorRect.height || 0);
  const desiredY = anchorTop + Math.round((anchorHeight - TOOLTIP_HEIGHT) / 2);
  const y = clamp(desiredY, workArea.y + TOOLTIP_MARGIN, workBottom - TOOLTIP_HEIGHT - TOOLTIP_MARGIN);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: TOOLTIP_WIDTH,
    height: TOOLTIP_HEIGHT
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

async function pollGameRunning() {
  if (gameRunningPollInFlight) {
    return;
  }
  gameRunningPollInFlight = true;
  try {
    const gameProcess = await getGameProcess();
    const gameRunning = Boolean(gameProcess);
    if (lastKnownGameRunning !== null && gameRunning !== lastKnownGameRunning && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mods:gameRunningChanged", gameRunning);
    }
    lastKnownGameRunning = gameRunning;
    if (nativeRuntimeManager) {
      const activeModFolders = gameRunning ? await getActiveModFolders() : [];
      await nativeRuntimeManager.handleProcess(gameProcess, activeModFolders);
    }
  } catch (error) {
    console.error("Game process watcher failed:", error);
    if (nativeRuntimeManager) {
      nativeRuntimeManager.setStatus({
        phase: "failed",
        label: "Monitor failed",
        message: error.message || String(error),
        loaded: 0,
        total: 0,
        mods: []
      });
    }
  } finally {
    gameRunningPollInFlight = false;
  }
}

function startGameRunningWatcher() {
  if (gameRunningPollTimer) {
    return;
  }
  pollGameRunning();
  gameRunningPollTimer = setInterval(pollGameRunning, 2000);
}

app.whenReady().then(() => {
  nativeRuntimeManager = new NativeRuntimeManager({
    userDataPath: app.getPath("userData"),
    bundledInjectorPath: path.join(__dirname, "runtime", "BellwrightNativeInjector.exe"),
    gameLogPath: path.join(getLocalAppDataPath(), "Bellwright", "Saved", "Logs", "Bellwright.log"),
    onStatusChanged: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("mods:nativeRuntimeChanged", status);
      }
    }
  });
  createWindow();
  startGameRunningWatcher();
});

app.on("before-quit", () => {
  if (gameRunningPollTimer) {
    clearInterval(gameRunningPollTimer);
    gameRunningPollTimer = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function readJson(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = bytes.toString("utf16le");
    } else {
      const sample = bytes.subarray(0, Math.min(bytes.length, 80));
      const nullCount = [...sample].filter((byte) => byte === 0).length;
      text = nullCount > sample.length / 4 ? bytes.toString("utf16le") : bytes.toString("utf8");
    }
    text = text.replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function execFileText(file, args) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

function execFileChecked(file, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function queryRegistryString(key, valueName) {
  const output = await execFileText("reg", ["query", key, "/v", valueName]);
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(valueName));
  if (!line) {
    return null;
  }
  const match = line.match(new RegExp(`^${valueName}\\s+REG_\\w+\\s+(.+)$`, "i"));
  return match ? match[1].trim().replace(/\//g, "\\") : null;
}

function decodeSteamVdfPath(value) {
  return value.replace(/\\\\/g, "\\").replace(/\//g, "\\");
}

async function readSteamLibraries(steamRoot) {
  const libraries = new Set([steamRoot]);
  const vdfPath = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
  let text = "";
  try {
    text = await fs.readFile(vdfPath, "utf8");
  } catch {
    return [...libraries];
  }

  for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    libraries.add(decodeSteamVdfPath(match[1]));
  }
  return [...libraries];
}

async function getSteamLibraryRoots() {
  const roots = new Set([DEFAULT_STEAM_ROOT]);
  const registryKeys = [
    "HKCU\\Software\\Valve\\Steam",
    "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam",
    "HKLM\\SOFTWARE\\Valve\\Steam"
  ];

  for (const key of registryKeys) {
    const steamPath = await queryRegistryString(key, "SteamPath");
    const installPath = await queryRegistryString(key, "InstallPath");
    for (const candidate of [steamPath, installPath]) {
      if (candidate) {
        roots.add(candidate);
      }
    }
  }

  const libraries = new Set();
  for (const root of roots) {
    for (const library of await readSteamLibraries(root)) {
      libraries.add(path.normalize(library));
    }
  }
  return [...libraries];
}

async function getInstallPaths() {
  if (cachedInstallPaths) {
    return cachedInstallPaths;
  }

  const steamLibraries = await getSteamLibraryRoots();
  let gameRoot = DEFAULT_GAME_ROOT;
  let gameLibraryRoot = DEFAULT_STEAM_ROOT;

  for (const libraryRoot of steamLibraries) {
    const candidateGameRoot = path.join(libraryRoot, "steamapps", "common", "Bellwright", "Bellwright");
    if (
      (await exists(path.join(candidateGameRoot, "Content", "Mods"))) ||
      (await exists(path.join(candidateGameRoot, "Binaries", "Win64", "BellwrightGame-Win64-Shipping.exe")))
    ) {
      gameRoot = candidateGameRoot;
      gameLibraryRoot = libraryRoot;
      break;
    }
  }

  const modsRoot = path.join(gameRoot, "Content", "Mods");
  let workshopRoot = path.join(gameLibraryRoot, "steamapps", "workshop", "content", GAME_APP_ID);

  for (const libraryRoot of steamLibraries) {
    const candidateWorkshopRoot = path.join(libraryRoot, "steamapps", "workshop", "content", GAME_APP_ID);
    if (await exists(candidateWorkshopRoot)) {
      workshopRoot = candidateWorkshopRoot;
      break;
    }
  }

  cachedInstallPaths = {
    gameRoot,
    modsRoot,
    workshopRoot,
    disabledRoot: path.join(gameRoot, "Content", DISABLED_FOLDER_NAME),
    workshopDisabledRoot: path.join(workshopRoot, DISABLED_FOLDER_NAME),
    legacyDisabledRoot: path.join(modsRoot, DISABLED_FOLDER_NAME),
    legacyRuntimeDisabledRoot: path.join(modsRoot, LEGACY_DISABLED_FOLDER_NAME)
  };
  return cachedInstallPaths;
}

async function listDirectories(directory) {
  if (!(await exists(directory))) {
    return [];
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}

function normalizeSteamId(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function getObjectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function normalizeAssetHashes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([asset, hash]) => typeof asset === "string" && asset.trim() && typeof hash === "string" && hash.trim())
      .map(([asset, hash]) => [asset.trim(), hash.trim()])
  );
}

async function describeMod(folderPath, status, sourceRoot = null, options = {}) {
  const folderName = path.basename(folderPath);
  const modInfo = await readJson(path.join(folderPath, "modinfo.json"));
  const files = await fs.readdir(folderPath).catch(() => []);
  const packageFiles = files.filter((file) => /\.(pak|sig|ucas|utoc)$/i.test(file));
  const title = modInfo?.title || modInfo?.folderName || folderName;
  const displayFolderName = modInfo?.folderName || folderName;
  const modName = modInfo?.folderName || folderName;
  const steamId = normalizeSteamId(modInfo?.steamId || options.workshopId || 0);
  const workshopId = options.workshopId || (steamId ? String(steamId) : null);
  const assetsToCook = getObjectKeys(modInfo?.assetsToCook);
  const version = modInfo?.version
    ? [modInfo.version.Main, modInfo.version.Major, modInfo.version.Minor, modInfo.version.Micro]
        .filter((part) => part !== undefined)
        .join(".")
    : "";

  const nativeRuntime = nativeRuntimeManager
    ? nativeRuntimeManager.publicInspection(await nativeRuntimeManager.inspectMod(folderPath, status === "active"))
    : null;
  const settingsStore = await readModSettingsStore();
  const settingsKey = modKeyFromParts(options.source || "local", folderName);
  let launcherSettings = null;
  let launcherSettingsError = null;
  try {
    launcherSettings = await inspectVariantSettings(folderPath, settingsStore.selections[settingsKey]);
  } catch (error) {
    launcherSettingsError = error.message || String(error);
  }

  return {
    folderName,
    displayFolderName,
    modName,
    title,
    description: modInfo?.description || "No description in modinfo.json.",
    author: modInfo?.author || "Unknown",
    tag: modInfo?.tag || "Mod",
    version,
    status,
    sourceRoot,
    source: options.source || "local",
    sourceLabel: options.sourceLabel || "Local",
    steamId,
    workshopId,
    activeFlag: typeof modInfo?.active === "boolean" ? modInfo.active : null,
    packageCount: packageFiles.length,
    hasModInfo: Boolean(modInfo),
    modDependencies: normalizeStringArray(modInfo?.modDependencies),
    assetsToCook,
    createdAssets: normalizeStringArray(modInfo?.createdAssets),
    modifiedAssets: normalizeStringArray(modInfo?.modifiedAssets),
    deletedAssets: normalizeStringArray(modInfo?.deletedAssets),
    referencingAssets: normalizeStringArray(modInfo?.referencingAssets),
    referencingAssetsToNotCook: normalizeStringArray(modInfo?.referencingAssetsToNotCook),
    assetHashes: normalizeAssetHashes(modInfo?.assetHashes),
    modHash: modInfo?.modHash || null,
    modKitVersion: modInfo?.modKitVersion || null,
    gameVersion: modInfo?.gameVersion || null,
    enforceSameMods: modInfo?.enforceSameMods || "",
    nativeRuntime,
    launcherSettings,
    launcherSettingsError,
    path: folderPath
  };
}

async function getGameProcess() {
  const names = [...GAME_PROCESS_NAMES].map((name) => path.basename(name, ".exe"));
  const script = `$names=@(${names.map((name) => `'${name.replace(/'/g, "''")}'`).join(",")});` +
    "$p=Get-Process -Name $names -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1;" +
    "if($p){$native=@();try{$native=@($p.Modules|Where-Object {$_.ModuleName -eq 'BellwrightNativePayload.dll'}|ForEach-Object {$_.FileName})}catch{};" +
    "[pscustomobject]@{pid=$p.Id;startTime=$p.StartTime.ToUniversalTime().ToString('o');path=$p.Path;nativeModules=$native}|ConvertTo-Json -Compress}";
  const output = await execFileText("powershell", ["-NoProfile", "-Command", script]);
  if (!output.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(output);
    return parsed?.pid && parsed?.path ? parsed : null;
  } catch {
    return null;
  }
}

async function getGameRunning() {
  return Boolean(await getGameProcess());
}

async function getActiveModFolders() {
  const installPaths = await getInstallPaths();
  const folders = [];
  for (const root of [installPaths.modsRoot, installPaths.workshopRoot]) {
    for (const folder of await listDirectories(root)) {
      if (!folder.startsWith("_")) {
        folders.push(path.join(root, folder));
      }
    }
  }
  return folders;
}

function getLocalAppDataPath() {
  return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || app.getPath("home"), "AppData", "Local");
}

function getModLoadOrderPath() {
  return path.join(getLocalAppDataPath(), "Bellwright", "Saved", "Config", MOD_LOAD_ORDER_FILE);
}

function modLoadOrderKeyFromParts(name, steamId) {
  return `${String(name || "").trim().toLowerCase()}:${normalizeSteamId(steamId)}`;
}

function modLoadOrderKeyFromEntry(entry) {
  return modLoadOrderKeyFromParts(entry?.name, entry?.steamId);
}

function modLoadOrderKeyFromMod(mod) {
  return modLoadOrderKeyFromParts(mod?.modName || mod?.displayFolderName || mod?.folderName, mod?.steamId || mod?.workshopId || 0);
}

function modLoadOrderEntryFromMod(mod) {
  return {
    name: mod.modName || mod.displayFolderName || mod.folderName,
    steamId: normalizeSteamId(mod.steamId || mod.workshopId || 0)
  };
}

async function readModLoadOrder() {
  const store = (await readJson(getModLoadOrderPath())) || {};
  const entries = Array.isArray(store.modLoadOrder) ? store.modLoadOrder : [];
  return entries
    .filter((entry) => entry && typeof entry.name === "string" && entry.name.trim())
    .map((entry) => ({
      name: entry.name.trim(),
      steamId: normalizeSteamId(entry.steamId)
    }));
}

async function writeModLoadOrder(entries) {
  const cleanEntries = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry?.name) {
      continue;
    }
    const cleanEntry = {
      name: String(entry.name).trim(),
      steamId: normalizeSteamId(entry.steamId)
    };
    const key = modLoadOrderKeyFromEntry(cleanEntry);
    if (!cleanEntry.name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    cleanEntries.push(cleanEntry);
  }
  const filePath = getModLoadOrderPath();
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify({ modLoadOrder: cleanEntries }, null, "\t")}\n`, "utf8");
}

function loadOrderEntriesEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => modLoadOrderKeyFromEntry(entry) === modLoadOrderKeyFromEntry(right[index]));
}

async function normalizeModLoadOrder(activeMods, existingEntries = null) {
  const entries = existingEntries || (await readModLoadOrder());
  const activeByOrderKey = new Map(activeMods.map((mod) => [modLoadOrderKeyFromMod(mod), mod]));
  const seen = new Set();
  const normalized = [];

  for (const entry of entries) {
    const key = modLoadOrderKeyFromEntry(entry);
    const mod = activeByOrderKey.get(key);
    if (!mod || seen.has(key)) {
      continue;
    }
    normalized.push(modLoadOrderEntryFromMod(mod));
    seen.add(key);
  }

  const missing = activeMods
    .filter((mod) => !seen.has(modLoadOrderKeyFromMod(mod)))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  for (const mod of missing) {
    normalized.push(modLoadOrderEntryFromMod(mod));
  }

  if (!loadOrderEntriesEqual(entries, normalized)) {
    await writeModLoadOrder(normalized);
    return { entries: normalized, changed: true };
  }
  return { entries, changed: false };
}

function getLoadOrderMap(entries) {
  const map = new Map();
  entries.forEach((entry, index) => {
    const key = modLoadOrderKeyFromEntry(entry);
    if (!map.has(key)) {
      map.set(key, index);
    }
  });
  return map;
}

async function setModActiveFlag(folderPath, active) {
  const modInfoPath = path.join(folderPath, "modinfo.json");
  const modInfo = await readJson(modInfoPath);
  if (!modInfo || modInfo.active === active) {
    return;
  }
  modInfo.active = active;
  await fs.writeFile(modInfoPath, `${JSON.stringify(modInfo, null, "\t")}\n`, "utf8");
}

async function removeModFromLoadOrder(mod) {
  const entries = await readModLoadOrder();
  const key = modLoadOrderKeyFromMod(mod);
  const nextEntries = entries.filter((entry) => modLoadOrderKeyFromEntry(entry) !== key);
  if (!loadOrderEntriesEqual(entries, nextEntries)) {
    await writeModLoadOrder(nextEntries);
  }
}

async function appendModToLoadOrder(mod) {
  const entries = await readModLoadOrder();
  const key = modLoadOrderKeyFromMod(mod);
  const nextEntries = entries.filter((entry) => modLoadOrderKeyFromEntry(entry) !== key);
  nextEntries.push(modLoadOrderEntryFromMod(mod));
  await writeModLoadOrder(nextEntries);
}

function collectModAssetOperations(mod) {
  const operations = new Map();
  const add = (asset, operation) => {
    if (!asset) {
      return;
    }
    const cleanAsset = String(asset).trim();
    if (!cleanAsset) {
      return;
    }
    if (!operations.has(cleanAsset)) {
      operations.set(cleanAsset, new Set());
    }
    operations.get(cleanAsset).add(operation);
  };

  for (const asset of mod.modifiedAssets || []) {
    add(asset, "modified");
  }
  for (const asset of mod.deletedAssets || []) {
    add(asset, "deleted");
  }
  for (const asset of mod.createdAssets || []) {
    add(asset, "created");
  }
  for (const asset of mod.assetsToCook || []) {
    add(asset, "cooked");
  }

  return operations;
}

function getConflictSeverity(left, right, assets) {
  const bothActive = left.status === "active" && right.status === "active";
  const hasDeletedAsset = assets.some((asset) => asset.leftOperations.includes("deleted") || asset.rightOperations.includes("deleted"));
  const duplicateInstall =
    left.modHash &&
    right.modHash &&
    left.modHash === right.modHash &&
    (left.source !== right.source || left.folderName !== right.folderName);

  if (bothActive && (hasDeletedAsset || duplicateInstall)) {
    return "high";
  }
  if (bothActive) {
    return "medium";
  }
  return duplicateInstall ? "medium" : "low";
}

function buildModConflicts(mods) {
  const conflicts = [];
  const conflictCounts = new Map(mods.map((mod) => [modKey(mod), { total: 0, active: 0, highest: "" }]));
  const operationMaps = new Map(mods.map((mod) => [modKey(mod), collectModAssetOperations(mod)]));
  const severityRank = { low: 1, medium: 2, high: 3 };

  for (let leftIndex = 0; leftIndex < mods.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < mods.length; rightIndex += 1) {
      const left = mods[leftIndex];
      const right = mods[rightIndex];
      const leftOperations = operationMaps.get(modKey(left));
      const rightOperations = operationMaps.get(modKey(right));
      const sharedAssets = [];

      for (const [asset, operations] of leftOperations.entries()) {
        if (!rightOperations.has(asset)) {
          continue;
        }
        sharedAssets.push({
          path: asset,
          leftOperations: [...operations].sort(),
          rightOperations: [...rightOperations.get(asset)].sort()
        });
      }

      const duplicateInstall =
        left.modHash &&
        right.modHash &&
        left.modHash === right.modHash &&
        (left.source !== right.source || left.folderName !== right.folderName);

      if (sharedAssets.length === 0 && !duplicateInstall) {
        continue;
      }

      const bothActive = left.status === "active" && right.status === "active";
      const severity = getConflictSeverity(left, right, sharedAssets);
      const winner =
        bothActive && Number.isFinite(left.loadOrderIndex) && Number.isFinite(right.loadOrderIndex)
          ? left.loadOrderIndex > right.loadOrderIndex
            ? left
            : right
          : null;
      const conflict = {
        id: `${modKey(left)}|${modKey(right)}`,
        severity,
        bothActive,
        duplicateInstall: Boolean(duplicateInstall),
        assetCount: sharedAssets.length,
        assets: sharedAssets.slice(0, MAX_CONFLICT_ASSETS),
        hasMoreAssets: sharedAssets.length > MAX_CONFLICT_ASSETS,
        mods: [
          {
            key: modKey(left),
            title: left.title,
            source: left.source,
            workshopId: left.workshopId,
            loadOrderIndex: left.loadOrderIndex,
            operationsLabel: left.sourceLabel
          },
          {
            key: modKey(right),
            title: right.title,
            source: right.source,
            workshopId: right.workshopId,
            loadOrderIndex: right.loadOrderIndex,
            operationsLabel: right.sourceLabel
          }
        ],
        winner: winner
          ? {
              key: modKey(winner),
              title: winner.title,
              loadOrderIndex: winner.loadOrderIndex
            }
          : null
      };
      conflicts.push(conflict);

      for (const mod of [left, right]) {
        const counts = conflictCounts.get(modKey(mod));
        counts.total += 1;
        if (bothActive) {
          counts.active += 1;
        }
        if (!counts.highest || severityRank[severity] > severityRank[counts.highest]) {
          counts.highest = severity;
        }
      }
    }
  }

  for (const mod of mods) {
    const counts = conflictCounts.get(modKey(mod)) || { total: 0, active: 0, highest: "" };
    mod.conflictCount = counts.total;
    mod.activeConflictCount = counts.active;
    mod.conflictSeverity = counts.highest;
  }

  return conflicts.sort((left, right) => {
    if (left.bothActive !== right.bothActive) {
      return left.bothActive ? -1 : 1;
    }
    const severityDifference = severityRank[right.severity] - severityRank[left.severity];
    if (severityDifference) {
      return severityDifference;
    }
    return right.assetCount - left.assetCount;
  });
}

async function migrateLegacyDisabledLocalMods(installPaths) {
  const legacyRoots = [installPaths.legacyDisabledRoot, installPaths.legacyRuntimeDisabledRoot].filter(Boolean);
  await ensureDirectory(installPaths.disabledRoot);

  for (const legacyRoot of legacyRoots) {
    if (!(await exists(legacyRoot))) {
      continue;
    }
    const folders = await listDirectories(legacyRoot);
    for (const folder of folders) {
      if (folder.startsWith("_")) {
        continue;
      }
      const source = path.join(legacyRoot, folder);
      const target = path.join(installPaths.disabledRoot, folder);
      const mod = await describeMod(source, "disabled", legacyRoot, { source: "local", sourceLabel: "Local disabled" });
      await setModActiveFlag(source, false).catch(() => {});
      await removeModFromLoadOrder(mod);
      if (await exists(target)) {
        continue;
      }
      await moveDirectory(source, target, installPaths);
      await setModActiveFlag(target, false).catch(() => {});
    }
  }
}

async function getState() {
  const installPaths = await getInstallPaths();
  const { gameRoot, modsRoot, workshopRoot, disabledRoot, workshopDisabledRoot, legacyDisabledRoot, legacyRuntimeDisabledRoot } =
    installPaths;
  const gameRunning = await getGameRunning();
  await ensureDirectory(modsRoot);
  await ensureDirectory(disabledRoot);
  await ensureDirectory(workshopDisabledRoot);
  if (!gameRunning) {
    await migrateLegacyDisabledLocalMods(installPaths);
    await reconcileUpdatedDisabledWorkshopMods(installPaths);
  }

  const activeFolders = await listDirectories(modsRoot);
  const activeMods = [];
  for (const folder of activeFolders) {
    if (folder.startsWith("_")) {
      continue;
    }
    const folderPath = path.join(modsRoot, folder);
    activeMods.push(await describeMod(folderPath, "active", null, { source: "local", sourceLabel: "Local" }));
  }

  const disabledRoots = [disabledRoot];
  if (await exists(legacyDisabledRoot)) {
    disabledRoots.push(legacyDisabledRoot);
  }
  if (await exists(legacyRuntimeDisabledRoot)) {
    disabledRoots.push(legacyRuntimeDisabledRoot);
  }

  const disabledMods = [];
  const seenDisabled = new Set();
  for (const disabledRoot of disabledRoots) {
    const disabledFolders = await listDirectories(disabledRoot);
    for (const folder of disabledFolders) {
      if (folder.startsWith("_") || seenDisabled.has(folder)) {
        continue;
      }
      seenDisabled.add(folder);
      const folderPath = path.join(disabledRoot, folder);
      disabledMods.push(
        await describeMod(folderPath, "disabled", disabledRoot, {
          source: "local",
          sourceLabel: "Local disabled"
        })
      );
    }
  }

  const workshopMods = [];
  const workshopFolders = await listDirectories(workshopRoot);
  for (const folder of workshopFolders) {
    if (folder.startsWith("_")) {
      continue;
    }
    const folderPath = path.join(workshopRoot, folder);
    workshopMods.push(
      await describeMod(folderPath, "active", null, {
        source: "workshop",
        sourceLabel: "Steam Workshop",
        workshopId: folder
      })
    );
  }

  const disabledWorkshopFolders = await listDirectories(workshopDisabledRoot);
  for (const folder of disabledWorkshopFolders) {
    if (folder.startsWith("_")) {
      continue;
    }
    const folderPath = path.join(workshopDisabledRoot, folder);
    disabledMods.push(
      await describeMod(folderPath, "disabled", workshopDisabledRoot, {
        source: "workshop",
        sourceLabel: "Steam Workshop disabled",
        workshopId: folder
      })
    );
  }

  const activeStateMods = [...activeMods, ...workshopMods];
  const { entries: loadOrder } = gameRunning
    ? { entries: await readModLoadOrder() }
    : await normalizeModLoadOrder(activeStateMods);
  const loadOrderMap = getLoadOrderMap(loadOrder);

  for (const mod of activeStateMods) {
    const loadOrderIndex = loadOrderMap.get(modLoadOrderKeyFromMod(mod));
    mod.loadOrderIndex = Number.isInteger(loadOrderIndex) ? loadOrderIndex : null;
    mod.priority = Number.isInteger(loadOrderIndex) ? LOAD_ORDER_BASE_PRIORITY + loadOrderIndex : null;
  }
  for (const mod of disabledMods) {
    mod.loadOrderIndex = null;
    mod.priority = null;
  }

  const mods = [...activeMods, ...workshopMods, ...disabledMods].sort((a, b) => {
    if (a.status === "active" && b.status === "active") {
      const leftOrder = Number.isInteger(a.loadOrderIndex) ? a.loadOrderIndex : Number.MAX_SAFE_INTEGER;
      const rightOrder = Number.isInteger(b.loadOrderIndex) ? b.loadOrderIndex : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
    }
    if (a.status !== b.status) {
      return a.status === "active" ? -1 : 1;
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
  const conflicts = buildModConflicts(mods);
  const nativeRuntime = nativeRuntimeManager ? nativeRuntimeManager.getStatus() : null;
  const nativeRuntimeById = new Map((nativeRuntime?.mods || []).map((runtimeMod) => [runtimeMod.id, runtimeMod]));
  for (const mod of mods) {
    if (mod.nativeRuntime?.id && nativeRuntimeById.has(mod.nativeRuntime.id)) {
      mod.nativeRuntime = { ...mod.nativeRuntime, ...nativeRuntimeById.get(mod.nativeRuntime.id) };
    }
  }

  return {
    gameRoot,
    modsRoot,
    workshopRoot,
    disabledRoot,
    workshopDisabledRoot,
    modLoadOrderPath: getModLoadOrderPath(),
    appId: GAME_APP_ID,
    gameRunning,
    nativeRuntime,
    mods,
    conflicts,
    activeConflictCount: conflicts.filter((conflict) => conflict.bothActive).length
  };
}

function assertSafeModName(folderName) {
  if (!folderName || folderName.includes("\\") || folderName.includes("/") || folderName === "." || folderName === "..") {
    throw new Error("Unsafe mod folder name.");
  }
  if (folderName.startsWith("_")) {
    throw new Error("Service folders cannot be toggled.");
  }
}

function assertInsideRoot(candidatePath, rootPath) {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(rootPath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the expected mod folder: ${candidatePath}`);
  }
}

async function assertGameClosed() {
  if (await getGameRunning()) {
    throw new Error("Close Bellwright before changing enabled mods.");
  }
}

async function moveDirectory(source, target, installPaths) {
  const allowedRoots = [
    installPaths.modsRoot,
    installPaths.disabledRoot,
    installPaths.legacyDisabledRoot,
    installPaths.legacyRuntimeDisabledRoot,
    installPaths.workshopRoot,
    installPaths.workshopDisabledRoot
  ];
  if (!allowedRoots.some((root) => {
    try {
      assertInsideRoot(source, root);
      return true;
    } catch {
      return false;
    }
  })) {
    throw new Error(`Unsupported source folder: ${source}`);
  }
  if (!allowedRoots.some((root) => {
    try {
      assertInsideRoot(target, root);
      return true;
    } catch {
      return false;
    }
  })) {
    throw new Error(`Unsupported target folder: ${target}`);
  }
  if (!(await exists(source))) {
    throw new Error(`Missing source folder: ${source}`);
  }
  if (await exists(target)) {
    throw new Error(`Target already exists: ${target}`);
  }
  await ensureDirectory(path.dirname(target));
  await fs.rename(source, target);
}

async function replaceDirectory(source, target, installPaths) {
  if (!(await exists(target))) {
    await moveDirectory(source, target, installPaths);
    return;
  }

  const backup = path.join(
    path.dirname(target),
    `_${path.basename(target)}.backup-${process.pid}-${Date.now()}`
  );
  await fs.rename(target, backup);
  try {
    await moveDirectory(source, target, installPaths);
  } catch (error) {
    if (!(await exists(target)) && (await exists(backup))) {
      await fs.rename(backup, target).catch(() => {});
    }
    throw error;
  }
  await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
}

async function reconcileUpdatedDisabledWorkshopMods(installPaths) {
  const disabledFolders = await listDirectories(installPaths.workshopDisabledRoot);
  for (const folderName of disabledFolders) {
    if (folderName.startsWith("_")) {
      continue;
    }

    const downloadedPath = path.join(installPaths.workshopRoot, folderName);
    if (!(await exists(downloadedPath))) {
      continue;
    }

    const disabledPath = path.join(installPaths.workshopDisabledRoot, folderName);
    const mod = await describeMod(downloadedPath, "active", null, {
      source: "workshop",
      sourceLabel: "Steam Workshop",
      workshopId: folderName
    });
    await replaceDirectory(downloadedPath, disabledPath, installPaths);
    await setModActiveFlag(disabledPath, false).catch(() => {});
    await removeModFromLoadOrder(mod);
  }
}

async function disableMod(payload) {
  const folderName = typeof payload === "string" ? payload : payload?.folderName;
  const source = typeof payload === "string" ? "local" : payload?.source || "local";
  const installPaths = await getInstallPaths();
  assertSafeModName(folderName);
  await assertGameClosed();

  if (source === "workshop") {
    const sourcePath = path.join(installPaths.workshopRoot, folderName);
    const targetPath = path.join(installPaths.workshopDisabledRoot, folderName);
    const mod = await describeMod(sourcePath, "active", null, { source: "workshop", sourceLabel: "Steam Workshop", workshopId: folderName });
    await replaceDirectory(sourcePath, targetPath, installPaths);
    await setModActiveFlag(targetPath, false).catch(() => {});
    await removeModFromLoadOrder(mod);
  } else {
    const sourcePath = path.join(installPaths.modsRoot, folderName);
    const targetPath = path.join(installPaths.disabledRoot, folderName);
    const mod = await describeMod(sourcePath, "active", null, { source: "local", sourceLabel: "Local" });
    await replaceDirectory(sourcePath, targetPath, installPaths);
    await setModActiveFlag(targetPath, false).catch(() => {});
    await removeModFromLoadOrder(mod);
  }
  return getState();
}

async function enableMod(payload) {
  const folderName = payload?.folderName;
  const installPaths = await getInstallPaths();
  const sourceRoot = payload?.sourceRoot || installPaths.disabledRoot;
  const source = payload?.source || "local";
  assertSafeModName(folderName);
  await assertGameClosed();

  const normalizedRoot = path.normalize(sourceRoot);
  const allowedRoots = [
    path.normalize(installPaths.disabledRoot),
    path.normalize(installPaths.legacyDisabledRoot),
    path.normalize(installPaths.legacyRuntimeDisabledRoot),
    path.normalize(installPaths.workshopDisabledRoot)
  ];
  if (!allowedRoots.includes(normalizedRoot)) {
    throw new Error("Unsupported disabled source folder.");
  }

  const targetRoot = source === "workshop" ? installPaths.workshopRoot : installPaths.modsRoot;
  const sourcePath = path.join(normalizedRoot, folderName);
  const targetPath = path.join(targetRoot, folderName);
  const mod = await describeMod(sourcePath, "disabled", normalizedRoot, {
    source,
    sourceLabel: source === "workshop" ? "Steam Workshop disabled" : "Local disabled",
    workshopId: source === "workshop" ? folderName : null
  });
  if (source === "workshop" && (await exists(targetPath))) {
    const downloadedMod = await describeMod(targetPath, "active", null, {
      source: "workshop",
      sourceLabel: "Steam Workshop",
      workshopId: folderName
    });
    await fs.rm(sourcePath, { recursive: true, force: true });
    await setModActiveFlag(targetPath, true).catch(() => {});
    await appendModToLoadOrder(downloadedMod);
    return getState();
  }
  await moveDirectory(sourcePath, targetPath, installPaths);
  await setModActiveFlag(targetPath, true).catch(() => {});
  await appendModToLoadOrder(mod);
  return getState();
}

async function setLoadOrder(payload) {
  await assertGameClosed();
  const requestedKeys = Array.isArray(payload) ? payload : payload?.keys;
  if (!Array.isArray(requestedKeys)) {
    throw new Error("Load order update is missing mod keys.");
  }

  const state = await getState();
  const activeMods = state.mods.filter((mod) => mod.status === "active");
  const modsByKey = new Map(activeMods.map((mod) => [modKey(mod), mod]));
  const seen = new Set();
  const orderedMods = [];

  for (const key of requestedKeys) {
    const mod = modsByKey.get(String(key));
    if (!mod || seen.has(modKey(mod))) {
      continue;
    }
    orderedMods.push(mod);
    seen.add(modKey(mod));
  }

  for (const mod of activeMods) {
    if (!seen.has(modKey(mod))) {
      orderedMods.push(mod);
    }
  }

  await writeModLoadOrder(orderedMods.map(modLoadOrderEntryFromMod));
  return getState();
}

function getPresetPath() {
  return path.join(app.getPath("userData"), "presets.json");
}

function getModSettingsPath() {
  return path.join(app.getPath("userData"), "mod-settings.json");
}

async function readModSettingsStore() {
  const store = (await readJson(getModSettingsPath())) || {};
  const selections = store.selections && typeof store.selections === "object" && !Array.isArray(store.selections)
    ? Object.fromEntries(Object.entries(store.selections).map(([key, value]) => [key, normalizeSelectionMap(value)]))
    : {};
  return { version: 1, selections };
}

async function writeModSettingsStore(store) {
  await ensureDirectory(path.dirname(getModSettingsPath()));
  await fs.writeFile(getModSettingsPath(), `${JSON.stringify({ version: 1, selections: store.selections || {} }, null, 2)}\n`, "utf8");
}

function modKeyFromParts(source, folderName) {
  return `${source || "local"}:${folderName}`;
}

function modKey(mod) {
  return modKeyFromParts(mod.source, mod.folderName);
}

function settingsFromMod(mod) {
  return Object.fromEntries((mod.launcherSettings?.groups || []).map((group) => [group.id, group.selectedOption]));
}

async function setModVariant(payload) {
  await assertGameClosed();
  const source = payload?.source === "workshop" ? "workshop" : "local";
  const folderName = String(payload?.folderName || "");
  assertSafeModName(folderName);
  const state = await getState();
  const mod = state.mods.find((candidate) => candidate.source === source && candidate.folderName === folderName);
  if (!mod) {
    throw new Error("Mod was not found.");
  }
  await applyVariantOption(mod.path, String(payload?.groupId || ""), String(payload?.optionId || ""));
  const store = await readModSettingsStore();
  const key = modKey(mod);
  store.selections[key] = {
    ...normalizeSelectionMap(store.selections[key]),
    [String(payload.groupId)]: String(payload.optionId)
  };
  await writeModSettingsStore(store);
  return getState();
}

async function applySavedVariantSelections() {
  await assertGameClosed();
  const state = await getState();
  const activeMods = state.mods.filter((mod) => mod.status === "active" && mod.launcherSettings?.groups?.length);
  for (const mod of activeMods) {
    for (const group of mod.launcherSettings.groups) {
      if (!group.inSync) {
        await applyVariantOption(mod.path, group.id, group.selectedOption);
      }
    }
  }
}

function normalizePresetName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function createPresetId(name) {
  const slug = normalizePresetName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "preset"}-${Date.now().toString(36)}`;
}

function publicPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    activeCount: preset.activeMods.length,
    activeMods: preset.activeMods
  };
}

function cleanSharedText(value, fallback, maxLength = 160) {
  const clean = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return clean || fallback;
}

function normalizeSharedPresetMod(mod) {
  const source = mod?.source === "workshop" ? "workshop" : "local";
  if (source === "workshop") {
    const steamId = normalizeSteamId(mod?.steamId || mod?.workshopId || mod?.folderName);
    if (!steamId) {
      throw new Error("Shared preset contains a Workshop mod without a valid ID.");
    }
    const folderName = String(steamId);
    const modName = cleanSharedText(mod?.modName || mod?.displayFolderName, folderName);
    return {
      source,
      folderName,
      displayFolderName: modName,
      modName,
      title: cleanSharedText(mod?.title, modName),
      steamId,
      workshopId: folderName,
      settings: normalizeSelectionMap(mod?.settings)
    };
  }

  const folderName = cleanSharedText(mod?.folderName, "", 180);
  assertSafeModName(folderName);
  const modName = cleanSharedText(mod?.modName || mod?.displayFolderName, folderName);
  return {
    source,
    folderName,
    displayFolderName: modName,
    modName,
    title: cleanSharedText(mod?.title, modName),
    steamId: 0,
    workshopId: null,
    settings: normalizeSelectionMap(mod?.settings)
  };
}

function normalizeSharedPresetPayload(payload) {
  if (!payload || payload.format !== 1 || String(payload.gameAppId) !== GAME_APP_ID) {
    throw new Error("This is not a supported Bellwright preset code.");
  }
  if (!Array.isArray(payload.mods) || payload.mods.length > MAX_SHARED_MODS) {
    throw new Error("Shared preset has an invalid mod list.");
  }

  const activeMods = [];
  const seen = new Set();
  for (const rawMod of payload.mods) {
    const mod = normalizeSharedPresetMod(rawMod);
    const key = modKey(mod);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    activeMods.push(mod);
  }

  return {
    name: cleanSharedText(payload.name, "Shared preset", 80),
    activeMods
  };
}

function encodePresetShareCode(preset) {
  const payload = {
    format: 1,
    gameAppId: GAME_APP_ID,
    name: preset.name,
    createdAt: new Date().toISOString(),
    mods: preset.activeMods.map(normalizeSharedPresetMod)
  };
  const compressed = zlib.deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 });
  return `${PRESET_SHARE_PREFIX}${compressed.toString("base64url")}`;
}

function decodePresetShareCode(value) {
  const code = String(value || "").replace(/\s+/g, "");
  if (!code.startsWith(PRESET_SHARE_PREFIX) || code.length > MAX_SHARE_CODE_LENGTH) {
    throw new Error("Invalid Bellwright preset code.");
  }

  try {
    const compressed = Buffer.from(code.slice(PRESET_SHARE_PREFIX.length), "base64url");
    const decoded = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_SHARED_PRESET_BYTES });
    return normalizeSharedPresetPayload(JSON.parse(decoded.toString("utf8")));
  } catch (error) {
    if (error?.message?.startsWith("Shared preset") || error?.message?.startsWith("This is not")) {
      throw error;
    }
    throw new Error("Preset code is damaged or unsupported.");
  }
}

async function copyPresetShareCode(id) {
  const store = await readPresetStore();
  const preset = store.presets.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error("Select a preset to share.");
  }
  const code = encodePresetShareCode(preset);
  clipboard.writeText(code);
  return { codeLength: code.length, preset: publicPreset(preset) };
}

async function inspectPresetShareCode(code) {
  const sharedPreset = decodePresetShareCode(code);
  const state = await getState();
  const installedByKey = new Map(state.mods.map((mod) => [modKey(mod), mod]));
  const mods = sharedPreset.activeMods.map((sharedMod, index) => {
    const installedMod = installedByKey.get(modKey(sharedMod));
    return {
      order: index + 1,
      title: installedMod?.title || sharedMod.title,
      modName: sharedMod.modName,
      source: sharedMod.source,
      workshopId: sharedMod.workshopId,
      installed: Boolean(installedMod),
      status: installedMod?.status || "missing"
    };
  });

  return {
    name: sharedPreset.name,
    activeCount: mods.length,
    installedCount: mods.filter((mod) => mod.installed).length,
    missingWorkshopCount: mods.filter((mod) => !mod.installed && mod.source === "workshop").length,
    missingLocalCount: mods.filter((mod) => !mod.installed && mod.source === "local").length,
    mods
  };
}

function getUniqueImportedPresetName(name, presets) {
  const names = new Set(presets.map((preset) => preset.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) {
    return name;
  }
  const base = `${name} (shared)`;
  if (!names.has(base.toLowerCase())) {
    return base;
  }
  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

async function importPresetShareCode(code) {
  const sharedPreset = decodePresetShareCode(code);
  const store = await readPresetStore();
  const now = new Date().toISOString();
  const preset = {
    id: createPresetId(sharedPreset.name),
    name: getUniqueImportedPresetName(sharedPreset.name, store.presets),
    createdAt: now,
    updatedAt: now,
    activeMods: sharedPreset.activeMods
  };
  store.presets.push(preset);
  await writePresetStore(store);
  return {
    preset: publicPreset(preset),
    presets: await listPresets()
  };
}

async function readPresetStore() {
  const store = (await readJson(getPresetPath())) || {};
  const presets = Array.isArray(store.presets) ? store.presets : [];
  return {
    version: 1,
    presets: presets
      .filter((preset) => preset && preset.id && preset.name && Array.isArray(preset.activeMods))
      .map((preset) => ({
        id: String(preset.id),
        name: String(preset.name),
        createdAt: preset.createdAt || new Date().toISOString(),
        updatedAt: preset.updatedAt || preset.createdAt || new Date().toISOString(),
        activeMods: preset.activeMods
          .filter((mod) => mod?.folderName)
          .map((mod) => ({
            source: mod.source || "local",
            folderName: mod.folderName,
            displayFolderName: mod.displayFolderName || mod.folderName,
            modName: mod.modName || mod.displayFolderName || mod.folderName,
            title: mod.title || mod.displayFolderName || mod.folderName,
            steamId: normalizeSteamId(mod.steamId || mod.workshopId || 0),
            workshopId: mod.workshopId || (mod.steamId ? String(mod.steamId) : null),
            settings: normalizeSelectionMap(mod.settings)
          }))
      }))
  };
}

async function writePresetStore(store) {
  await ensureDirectory(path.dirname(getPresetPath()));
  await fs.writeFile(getPresetPath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function listPresets() {
  const store = await readPresetStore();
  return store.presets
    .map(publicPreset)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function savePreset(payload) {
  const name = normalizePresetName(typeof payload === "string" ? payload : payload?.name);
  if (!name) {
    throw new Error("Preset name is required.");
  }

  const store = await readPresetStore();
  const now = new Date().toISOString();
  const state = await getState();
  const activeMods = state.mods
    .filter((mod) => mod.status === "active")
    .map((mod) => ({
      source: mod.source,
      folderName: mod.folderName,
      displayFolderName: mod.displayFolderName,
      modName: mod.modName,
      title: mod.title,
      steamId: mod.steamId || 0,
      workshopId: mod.workshopId || null,
      settings: settingsFromMod(mod)
    }));

  const existing = store.presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  const preset = {
    id: existing?.id || createPresetId(name),
    name,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    activeMods
  };

  if (existing) {
    Object.assign(existing, preset);
  } else {
    store.presets.push(preset);
  }

  await writePresetStore(store);
  return {
    preset: publicPreset(preset),
    presets: await listPresets()
  };
}

async function deletePreset(id) {
  const store = await readPresetStore();
  const before = store.presets.length;
  store.presets = store.presets.filter((preset) => preset.id !== id);
  if (store.presets.length === before) {
    throw new Error("Preset was not found.");
  }
  await writePresetStore(store);
  return listPresets();
}

async function loadPreset(id) {
  await assertGameClosed();
  const store = await readPresetStore();
  const preset = store.presets.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error("Preset was not found.");
  }

  let currentState = await getState();
  const targetKeys = new Set(preset.activeMods.map(modKey));
  const currentKeys = new Set(currentState.mods.map(modKey));
  const missing = preset.activeMods.filter((savedMod) => !currentKeys.has(modKey(savedMod)));
  if (missing.length) {
    const workshopCount = missing.filter((mod) => mod.source === "workshop").length;
    const localCount = missing.length - workshopCount;
    const parts = [];
    if (workshopCount) {
      parts.push(`${workshopCount} Workshop mod${workshopCount === 1 ? "" : "s"}`);
    }
    if (localCount) {
      parts.push(`${localCount} local mod${localCount === 1 ? "" : "s"}`);
    }
    throw new Error(
      `${parts.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing. Install ${missing.length === 1 ? "it" : "them"} before loading this preset.`
    );
  }
  let changed = 0;

  for (const mod of currentState.mods.filter((candidate) => candidate.status === "active" && !targetKeys.has(modKey(candidate)))) {
    currentState = await disableMod({ folderName: mod.folderName, source: mod.source });
    changed += 1;
  }

  currentState = await getState();
  const activeKeys = new Set(currentState.mods.filter((mod) => mod.status === "active").map(modKey));

  for (const savedMod of preset.activeMods) {
    const key = modKey(savedMod);
    if (activeKeys.has(key)) {
      continue;
    }
    const candidate = currentState.mods.find((mod) => modKey(mod) === key);
    if (!candidate || candidate.status !== "disabled") {
      continue;
    }
    currentState = await enableMod({
      folderName: candidate.folderName,
      sourceRoot: candidate.sourceRoot,
      source: candidate.source
    });
    activeKeys.add(key);
    changed += 1;
  }

  currentState = await getState();
  const settingsStore = await readModSettingsStore();
  let settingsChanged = 0;
  for (const savedMod of preset.activeMods) {
    const selectedSettings = normalizeSelectionMap(savedMod.settings);
    if (!Object.keys(selectedSettings).length) {
      continue;
    }
    const candidate = currentState.mods.find((mod) => mod.status === "active" && modKey(mod) === modKey(savedMod));
    if (!candidate?.launcherSettings) {
      continue;
    }
    for (const [groupId, optionId] of Object.entries(selectedSettings)) {
      const group = candidate.launcherSettings.groups.find((item) => item.id === groupId);
      if (!group?.options.some((option) => option.id === optionId)) {
        continue;
      }
      if (group.appliedOption !== optionId) {
        await applyVariantOption(candidate.path, groupId, optionId);
        settingsChanged += 1;
      }
    }
    settingsStore.selections[modKey(candidate)] = selectedSettings;
  }
  await writeModSettingsStore(settingsStore);

  currentState = await getState();
  const finalActiveMods = currentState.mods.filter((mod) => mod.status === "active");
  const finalActiveByKey = new Map(finalActiveMods.map((mod) => [modKey(mod), mod]));
  const orderedActiveMods = [];
  const orderedKeys = new Set();
  for (const savedMod of preset.activeMods) {
    const activeMod = finalActiveByKey.get(modKey(savedMod));
    if (!activeMod || orderedKeys.has(modKey(activeMod))) {
      continue;
    }
    orderedActiveMods.push(activeMod);
    orderedKeys.add(modKey(activeMod));
  }
  for (const mod of finalActiveMods) {
    if (!orderedKeys.has(modKey(mod))) {
      orderedActiveMods.push(mod);
    }
  }
  const beforeEntries = await readModLoadOrder();
  const nextEntries = orderedActiveMods.map(modLoadOrderEntryFromMod);
  const orderChanged = !loadOrderEntriesEqual(beforeEntries, nextEntries);
  if (orderChanged) {
    await writeModLoadOrder(nextEntries);
  }

  return {
    preset: publicPreset(preset),
    state: await getState(),
    changed,
    settingsChanged,
    orderChanged,
    missing
  };
}

function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:updateProgress", payload);
  }
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function parseVersionParts(version) {
  const [core] = normalizeVersion(version).split("-");
  return core.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function compareVersions(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": `${packageInfo.name}/${packageInfo.version}`,
          Accept: "application/vnd.github+json"
        }
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          requestJson(response.headers.location).then(resolve, reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`GitHub returned HTTP ${response.statusCode}.`));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error("GitHub request timed out."));
    });
  });
}

function downloadFile(url, targetPath, onProgress) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": `${packageInfo.name}/${packageInfo.version}`
        }
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          downloadFile(response.headers.location, targetPath, onProgress).then(resolve, reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`Download returned HTTP ${response.statusCode}.`));
          return;
        }

        const total = Number.parseInt(response.headers["content-length"] || "0", 10) || 0;
        let transferred = 0;
        const file = fsNative.createWriteStream(targetPath);

        response.on("data", (chunk) => {
          transferred += chunk.length;
          onProgress?.({
            phase: "download",
            transferred,
            total,
            percent: total ? Math.round((transferred / total) * 100) : null,
            message: total ? "Downloading update..." : "Downloading update..."
          });
        });

        file.on("finish", () => {
          file.close(resolve);
        });
        file.on("error", reject);
        response.on("error", reject);
        response.pipe(file);
      }
    );
    request.on("error", reject);
    request.setTimeout(120000, () => {
      request.destroy(new Error("Update download timed out."));
    });
  });
}

function findUpdateAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return (
    assets.find((asset) => UPDATE_ASSET_PATTERN.test(asset.name || "")) ||
    assets.find((asset) => /\.zip$/i.test(asset.name || ""))
  );
}

async function fetchLatestRelease() {
  return requestJson(`${GITHUB_API_BASE}/releases/latest`);
}

async function expandZip(zipPath, destinationPath) {
  await fs.rm(destinationPath, { recursive: true, force: true });
  await ensureDirectory(destinationPath);
  await execFileChecked("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "& { param($zip, $destination) Expand-Archive -LiteralPath $zip -DestinationPath $destination -Force }",
    zipPath,
    destinationPath
  ]);
}

async function findStagedAppRoot(extractedRoot) {
  const candidates = [extractedRoot];
  const entries = await fs.readdir(extractedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      candidates.push(path.join(extractedRoot, entry.name));
    }
  }

  for (const candidate of candidates) {
    if (
      (await exists(path.join(candidate, UPDATE_EXE_NAME))) &&
      (await exists(path.join(candidate, "resources", "app", "package.json")))
    ) {
      return candidate;
    }
  }
  throw new Error("The downloaded ZIP does not contain a valid BellwrightModLauncher.exe package.");
}

function getInstallDirectory() {
  return path.dirname(process.execPath);
}

function getUpdaterScriptText() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$StagedAppDir,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-UpdateLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $LogPath -Value $line
}

function Invoke-WithRetry([scriptblock]$Action, [string]$Description) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    try {
      & $Action
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 250
    }
  }
  throw "$Description failed after retries: $($lastError.Exception.Message)"
}

try {
  $install = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $staged = [System.IO.Path]::GetFullPath($StagedAppDir).TrimEnd('\')
  $driveRoot = [System.IO.Path]::GetPathRoot($install).TrimEnd('\')

  Write-UpdateLog "Starting update. Install=$install Staged=$staged"

  if ($install -eq $driveRoot) {
    throw "Refusing to update a drive root."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $install $ExeName))) {
    throw "Install folder does not contain $ExeName."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $staged $ExeName))) {
    throw "Staged update does not contain $ExeName."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $staged "resources\app\package.json"))) {
    throw "Staged update is missing resources\app\package.json."
  }

  $parent = Split-Path -Parent $install
  $leaf = Split-Path -Leaf $install
  $stamp = Get-Date -Format yyyyMMddHHmmssfff
  $backupLeaf = "$leaf.old-$stamp"
  $backup = Join-Path $parent $backupLeaf
  $replacementLeaf = "$leaf.new-$stamp"
  $replacement = Join-Path $parent $replacementLeaf

  New-Item -ItemType Directory -Path $replacement | Out-Null
  try {
    $items = @(Get-ChildItem -LiteralPath $staged -Force)
    if ($items.Count -eq 0) {
      throw "Staged update folder is empty."
    }
    $items | Copy-Item -Destination $replacement -Recurse -Force
  } catch {
    Remove-Item -LiteralPath $replacement -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }

  $deadline = (Get-Date).AddSeconds(20)
  do {
    $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      if (-not $_.ExecutablePath) { return $false }
      try {
        $candidate = [System.IO.Path]::GetFullPath($_.ExecutablePath)
        return $candidate.StartsWith($install + '\', [System.StringComparison]::OrdinalIgnoreCase)
      } catch {
        return $false
      }
    })
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  if ($running.Count -gt 0) {
    Write-UpdateLog "Stopping lingering launcher processes: $($running.ProcessId -join ',')"
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 750
  }

  $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    try {
      $candidate = [System.IO.Path]::GetFullPath($_.ExecutablePath)
      return $candidate.StartsWith($install + '\', [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      return $false
    }
  })
  if ($remaining.Count -gt 0) {
    throw "Launcher processes are still using the install folder."
  }

  Invoke-WithRetry { Rename-Item -LiteralPath $install -NewName $backupLeaf } "Backing up the current installation"

  try {
    Invoke-WithRetry { Rename-Item -LiteralPath $replacement -NewName $leaf } "Activating the new installation"
  } catch {
    if (Test-Path -LiteralPath $replacement) {
      Remove-Item -LiteralPath $replacement -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $install) -and (Test-Path -LiteralPath $backup)) {
      Rename-Item -LiteralPath $backup -NewName $leaf
    }
    throw
  }

  $exePath = Join-Path $install $ExeName
  Start-Process -FilePath $exePath -WorkingDirectory $install
  Start-Sleep -Milliseconds 750
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  Write-UpdateLog "Update applied and launcher restarted."
} catch {
  Write-UpdateLog "Update failed: $($_.Exception.Message)"
}`;
}

async function writeUpdaterScript(updateRoot) {
  const scriptPath = path.join(updateRoot, "apply-update.ps1");
  await fs.writeFile(scriptPath, getUpdaterScriptText(), "utf8");
  return scriptPath;
}

async function startUpdaterAndQuit(stagedAppRoot, updateRoot) {
  const installDir = getInstallDirectory();
  const scriptPath = await writeUpdaterScript(updateRoot);
  const logPath = path.join(updateRoot, "apply-update.log");
  const child = childProcess.spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-InstallDir",
      installDir,
      "-StagedAppDir",
      stagedAppRoot,
      "-ExeName",
      UPDATE_EXE_NAME,
      "-ProcessId",
      String(process.pid),
      "-LogPath",
      logPath
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  app.quit();
}

async function updateLauncher() {
  if (updateInProgress) {
    throw new Error("An update is already in progress.");
  }
  updateInProgress = true;

  try {
    sendUpdateProgress({ phase: "check", percent: 0, message: "Checking GitHub release..." });
    const release = await fetchLatestRelease();
    const latestVersion = normalizeVersion(release.tag_name || release.name || "");
    if (!latestVersion) {
      throw new Error("Latest GitHub release does not have a version tag.");
    }

    if (compareVersions(latestVersion, packageInfo.version) <= 0) {
      sendUpdateProgress({ phase: "done", percent: 100, message: "Launcher is up to date." });
      return { status: "up-to-date", currentVersion: packageInfo.version, latestVersion };
    }

    if (!app.isPackaged) {
      throw new Error("Auto-update can only be applied from the packaged launcher, not the development copy.");
    }

    const asset = findUpdateAsset(release);
    if (!asset?.browser_download_url) {
      throw new Error(`Release v${latestVersion} does not include a Windows portable ZIP.`);
    }

    const updateSession = `${latestVersion}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const updateRoot = path.join(app.getPath("userData"), "updates", updateSession);
    const zipPath = path.join(updateRoot, asset.name || `BellwrightModLauncher-v${latestVersion}.zip`);
    const extractedRoot = path.join(updateRoot, "extracted");
    await ensureDirectory(updateRoot);

    sendUpdateProgress({ phase: "download", percent: 0, message: `Downloading v${latestVersion}...` });
    await downloadFile(asset.browser_download_url, zipPath, sendUpdateProgress);

    sendUpdateProgress({ phase: "extract", percent: 100, message: "Preparing update..." });
    await expandZip(zipPath, extractedRoot);
    const stagedAppRoot = await findStagedAppRoot(extractedRoot);

    sendUpdateProgress({ phase: "ready", percent: 100, message: "Update downloaded." });
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["OK", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Restart to apply update",
      message: "Update downloaded. Restart to apply update?",
      detail: `Bellwright Mod Launcher v${latestVersion} is ready.`
    });

    if (choice.response === 0) {
      await startUpdaterAndQuit(stagedAppRoot, updateRoot);
      return { status: "restarting", latestVersion };
    }

    return { status: "staged", latestVersion };
  } finally {
    updateInProgress = false;
  }
}

function getAppInfo() {
  return {
    maker: "FSD Software",
    version: packageInfo.version,
    donateUrl: DONATE_URL,
    discordUrl: DISCORD_URL,
    updateSupported: app.isPackaged,
    updateRepo: `${GITHUB_OWNER}/${GITHUB_REPO}`
  };
}

ipcMain.handle("mods:getState", getState);

ipcMain.on("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on("window:toggleMaximize", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return;
  }
  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
});

ipcMain.on("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("app:getInfo", getAppInfo);

ipcMain.handle("presets:list", async () => {
  return listPresets();
});

ipcMain.handle("presets:save", async (_event, payload) => {
  return savePreset(payload);
});

ipcMain.handle("presets:load", async (_event, id) => {
  return loadPreset(id);
});

ipcMain.handle("presets:delete", async (_event, id) => {
  return deletePreset(id);
});

ipcMain.handle("presets:copyShareCode", async (_event, id) => {
  return copyPresetShareCode(id);
});

ipcMain.handle("presets:inspectShareCode", async (_event, code) => {
  return inspectPresetShareCode(code);
});

ipcMain.handle("presets:importShareCode", async (_event, code) => {
  return importPresetShareCode(code);
});

ipcMain.handle("app:updateLauncher", async () => {
  return updateLauncher();
});

ipcMain.handle("mods:disable", async (_event, payload) => {
  return disableMod(payload);
});

ipcMain.handle("mods:enable", async (_event, payload) => {
  return enableMod(payload);
});

ipcMain.handle("mods:setLoadOrder", async (_event, payload) => {
  return setLoadOrder(payload);
});

ipcMain.handle("mods:setVariant", async (_event, payload) => {
  return setModVariant(payload);
});

ipcMain.handle("mods:showTooltip", async (_event, payload) => {
  return showTooltipWindow(payload);
});

ipcMain.handle("mods:hideTooltip", async () => {
  hideTooltipWindow();
  return true;
});

ipcMain.handle("mods:openModsFolder", async () => {
  const { modsRoot } = await getInstallPaths();
  await ensureDirectory(modsRoot);
  await shell.openPath(modsRoot);
});

ipcMain.handle("mods:launchGame", async () => {
  await applySavedVariantSelections();
  await shell.openExternal(`steam://rungameid/${GAME_APP_ID}`);
  return true;
});

ipcMain.handle("mods:openWorkshopItem", async (_event, workshopId) => {
  const id = normalizeSteamId(workshopId);
  if (!id) {
    throw new Error("Invalid Workshop item ID.");
  }
  await shell.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`);
  return true;
});

ipcMain.handle("app:openDonate", async () => {
  if (!DONATE_URL) {
    throw new Error("Donate URL is not configured.");
  }
  await shell.openExternal(DONATE_URL);
  return true;
});

ipcMain.handle("app:openDiscord", async () => {
  if (!DISCORD_URL) {
    throw new Error("Discord URL is not configured.");
  }
  await shell.openExternal(DISCORD_URL);
  return true;
});
