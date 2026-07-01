const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const childProcess = require("child_process");
const packageInfo = require("./package.json");

const GAME_APP_ID = "1812450";
const DEFAULT_STEAM_ROOT = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam");
const DEFAULT_GAME_ROOT = path.join(DEFAULT_STEAM_ROOT, "steamapps", "common", "Bellwright", "Bellwright");
const DISABLED_FOLDER_NAME = "_disabled_by_bellwright_launcher";
const LEGACY_DISABLED_FOLDER_NAME = "_disabled_for_runtime_scoped_test";
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

let mainWindow;
let tooltipWindow;
let tooltipReady = false;
let pendingTooltipMod = null;
let cachedInstallPaths = null;

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

app.whenReady().then(createWindow);

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
    disabledRoot: path.join(modsRoot, DISABLED_FOLDER_NAME),
    workshopDisabledRoot: path.join(workshopRoot, DISABLED_FOLDER_NAME),
    legacyDisabledRoot: path.join(modsRoot, LEGACY_DISABLED_FOLDER_NAME)
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

async function describeMod(folderPath, status, sourceRoot = null, options = {}) {
  const folderName = path.basename(folderPath);
  const modInfo = await readJson(path.join(folderPath, "modinfo.json"));
  const files = await fs.readdir(folderPath).catch(() => []);
  const packageFiles = files.filter((file) => /\.(pak|sig|ucas|utoc)$/i.test(file));
  const title = modInfo?.title || modInfo?.folderName || folderName;
  const displayFolderName = modInfo?.folderName || folderName;
  const version = modInfo?.version
    ? [modInfo.version.Main, modInfo.version.Major, modInfo.version.Minor, modInfo.version.Micro]
        .filter((part) => part !== undefined)
        .join(".")
    : "";

  return {
    folderName,
    displayFolderName,
    title,
    description: modInfo?.description || "No description in modinfo.json.",
    author: modInfo?.author || "Unknown",
    tag: modInfo?.tag || "Mod",
    version,
    status,
    sourceRoot,
    source: options.source || "local",
    sourceLabel: options.sourceLabel || "Local",
    workshopId: options.workshopId || null,
    packageCount: packageFiles.length,
    hasModInfo: Boolean(modInfo),
    path: folderPath
  };
}

async function getGameRunning() {
  return new Promise((resolve) => {
    childProcess.exec(
      "powershell -NoProfile -Command \"Get-Process | Select-Object -ExpandProperty ProcessName\"",
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        const processNames = stdout
          .split(/\r?\n/)
          .map((name) => `${name}.exe`)
          .filter(Boolean);
        resolve(processNames.some((name) => GAME_PROCESS_NAMES.has(name)));
      }
    );
  });
}

async function getState() {
  const installPaths = await getInstallPaths();
  const { gameRoot, modsRoot, workshopRoot, disabledRoot, workshopDisabledRoot, legacyDisabledRoot } = installPaths;
  await ensureDirectory(modsRoot);
  await ensureDirectory(disabledRoot);
  await ensureDirectory(workshopDisabledRoot);

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

  const mods = [...activeMods, ...disabledMods, ...workshopMods].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
  );

  return {
    gameRoot,
    modsRoot,
    workshopRoot,
    disabledRoot,
    workshopDisabledRoot,
    appId: GAME_APP_ID,
    gameRunning: await getGameRunning(),
    mods
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

async function disableMod(payload) {
  const folderName = typeof payload === "string" ? payload : payload?.folderName;
  const source = typeof payload === "string" ? "local" : payload?.source || "local";
  const installPaths = await getInstallPaths();
  assertSafeModName(folderName);
  await assertGameClosed();

  if (source === "workshop") {
    await moveDirectory(
      path.join(installPaths.workshopRoot, folderName),
      path.join(installPaths.workshopDisabledRoot, folderName),
      installPaths
    );
  } else {
    await moveDirectory(
      path.join(installPaths.modsRoot, folderName),
      path.join(installPaths.disabledRoot, folderName),
      installPaths
    );
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
    path.normalize(installPaths.workshopDisabledRoot)
  ];
  if (!allowedRoots.includes(normalizedRoot)) {
    throw new Error("Unsupported disabled source folder.");
  }

  const targetRoot = source === "workshop" ? installPaths.workshopRoot : installPaths.modsRoot;
  await moveDirectory(path.join(normalizedRoot, folderName), path.join(targetRoot, folderName), installPaths);
  return getState();
}

function getAppInfo() {
  return {
    maker: "FSD Software",
    version: packageInfo.version,
    donateUrl: DONATE_URL,
    discordUrl: DISCORD_URL
  };
}

ipcMain.handle("mods:getState", getState);

ipcMain.handle("app:getInfo", getAppInfo);

ipcMain.handle("mods:disable", async (_event, payload) => {
  return disableMod(payload);
});

ipcMain.handle("mods:enable", async (_event, payload) => {
  return enableMod(payload);
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
  await shell.openExternal(`steam://rungameid/${GAME_APP_ID}`);
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
