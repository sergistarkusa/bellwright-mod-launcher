const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const childProcess = require("child_process");

const MANIFEST_FILE = "native-runtime.json";
const STAGED_PAYLOAD_NAME = "BellwrightNativePayload.dll";
const STAGED_INJECTOR_NAME = "BellwrightNativeInjector.exe";

const TRUSTED_NATIVE_MODS = new Map([
  [
    "fsd.settlement-immigration",
    {
      publisher: "FSD Software",
      payloadHashes: new Set(["4cd3f7d3b349cb678ff53e81bd66e8dcceb7d9cb87331a8906aabd3ef835c487"]),
      gameHashes: new Set(["5d77d16d59831f684dce32d513db9cdc671f6f78d5b67b44f4e8d7b8f816b3e1"])
    }
  ]
]);

const BUNDLED_INJECTOR_HASH = "cd07010b5f3114cd89c115d507bf8fb18f69c21b1b2c50d2f15522bb969faa8e";

async function readJson(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim() || path.isAbsolute(relativePath)) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function normalizeHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function normalizeManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return {
    schemaVersion: Number(raw.schemaVersion),
    id: typeof raw.id === "string" ? raw.id.trim() : "",
    displayName: typeof raw.displayName === "string" ? raw.displayName.trim() : "",
    publisher: typeof raw.publisher === "string" ? raw.publisher.trim() : "",
    version: typeof raw.version === "string" ? raw.version.trim() : "",
    payload: typeof raw.payload === "string" ? raw.payload.trim() : "",
    payloadSha256: normalizeHash(raw.payloadSha256),
    loadStage: raw.loadStage === "main-menu" ? "main-menu" : "",
    healthLog: typeof raw.healthLog === "string" ? raw.healthLog.trim() : ""
  };
}

class NativeRuntimeManager {
  constructor(options) {
    this.userDataPath = options.userDataPath;
    this.bundledInjectorPath = options.bundledInjectorPath;
    this.gameLogPath = options.gameLogPath;
    this.onStatusChanged = options.onStatusChanged || (() => {});
    this.hashCache = new Map();
    this.sessionPid = null;
    this.sessionReady = false;
    this.injectedIds = new Set();
    this.status = {
      phase: "idle",
      label: "Idle",
      message: "No active native mods",
      loaded: 0,
      total: 0,
      mods: []
    };
  }

  getStatus() {
    return { ...this.status, mods: this.status.mods.map((mod) => ({ ...mod })) };
  }

  setStatus(next) {
    const normalized = { ...next, updatedAt: new Date().toISOString() };
    const previousComparable = { ...this.status, updatedAt: undefined };
    const nextComparable = { ...normalized, updatedAt: undefined };
    if (JSON.stringify(previousComparable) === JSON.stringify(nextComparable)) {
      return;
    }
    this.status = normalized;
    this.onStatusChanged(this.getStatus());
  }

  async hashFile(filePath) {
    const stat = await fs.stat(filePath);
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    if (this.hashCache.has(cacheKey)) {
      return this.hashCache.get(cacheKey);
    }
    const hash = crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
    this.hashCache.set(cacheKey, hash);
    return hash;
  }

  async inspectMod(folderPath, active) {
    const manifestPath = path.join(folderPath, MANIFEST_FILE);
    if (!(await exists(manifestPath))) {
      return null;
    }

    const manifest = normalizeManifest(await readJson(manifestPath));
    if (!manifest || manifest.schemaVersion !== 1 || !manifest.id || !manifest.publisher || !manifest.payload) {
      return { phase: "invalid", label: "Invalid runtime", message: "native-runtime.json is incomplete" };
    }

    const payloadPath = resolveInside(folderPath, manifest.payload);
    if (!payloadPath || !(await exists(payloadPath))) {
      return {
        ...manifest,
        phase: "missing",
        label: "Payload missing",
        message: "The native payload file was not found"
      };
    }

    const trusted = TRUSTED_NATIVE_MODS.get(manifest.id);
    if (!trusted || trusted.publisher !== manifest.publisher) {
      return { ...manifest, phase: "untrusted", label: "Untrusted", message: "Publisher is not trusted by this launcher" };
    }

    const actualHash = await this.hashFile(payloadPath);
    if (manifest.payloadSha256 !== actualHash || !trusted.payloadHashes.has(actualHash)) {
      return { ...manifest, phase: "blocked", label: "Blocked", message: "Payload signature does not match" };
    }

    return {
      ...manifest,
      phase: active ? "ready" : "disabled",
      label: active ? "Runtime ready" : "Runtime disabled",
      message: active ? "Trusted payload is ready to load" : "Enable the mod to load its runtime",
      payloadPath,
      actualHash
    };
  }

  publicInspection(inspection) {
    if (!inspection) {
      return null;
    }
    const { payloadPath, actualHash, ...publicFields } = inspection;
    return publicFields;
  }

  resetSession() {
    this.sessionPid = null;
    this.sessionReady = false;
    this.injectedIds.clear();
    this.setStatus({
      phase: "idle",
      label: "Idle",
      message: "Game is closed",
      loaded: 0,
      total: 0,
      mods: []
    });
  }

  async isGameReady(gameProcess) {
    if (this.sessionReady) {
      return true;
    }
    try {
      const stat = await fs.stat(this.gameLogPath);
      const processStart = Date.parse(gameProcess.startTime || "");
      if (Number.isFinite(processStart) && stat.mtimeMs + 5000 < processStart) {
        return false;
      }
      const file = await fs.open(this.gameLogPath, "r");
      try {
        const headSize = Math.min(stat.size, 2 * 1024 * 1024);
        const tailSize = Math.min(stat.size, 256 * 1024);
        const head = Buffer.alloc(headSize);
        const tail = Buffer.alloc(tailSize);
        await file.read(head, 0, headSize, 0);
        await file.read(tail, 0, tailSize, stat.size - tailSize);
        const logSample = `${head.toString("utf8")}\n${tail.toString("utf8")}`;
        this.sessionReady = logSample.includes("AdvanceToMainMenu") ||
          logSample.includes("UEngine::LoadMap Load map complete /Game/Mist/Maps/Menu");
        return this.sessionReady;
      } finally {
        await file.close();
      }
    } catch {
      return false;
    }
  }

  async runInjector(executable) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(executable, [], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }
        resolve(stdout);
      });
    });
  }

  async stageAndInject(inspection) {
    const injectorHash = await this.hashFile(this.bundledInjectorPath);
    if (injectorHash !== BUNDLED_INJECTOR_HASH) {
      throw new Error("Bundled native injector failed integrity verification");
    }

    const stageRoot = this.getStageRoot(inspection);
    await fs.mkdir(stageRoot, { recursive: true });
    const stagedPayload = path.join(stageRoot, STAGED_PAYLOAD_NAME);
    const stagedInjector = path.join(stageRoot, STAGED_INJECTOR_NAME);
    await fs.copyFile(inspection.payloadPath, stagedPayload);
    await fs.copyFile(this.bundledInjectorPath, stagedInjector);
    if ((await this.hashFile(stagedPayload)) !== inspection.actualHash) {
      throw new Error("Staged payload failed integrity verification");
    }
    await this.runInjector(stagedInjector);
  }

  getStageRoot(inspection) {
    const safeId = inspection.id.replace(/[^a-z0-9._-]/gi, "_");
    return path.join(this.userDataPath, "native-runtime", safeId, inspection.actualHash);
  }

  async handleProcess(gameProcess, activeModFolders) {
    if (!gameProcess) {
      this.resetSession();
      return;
    }
    if (this.sessionPid !== gameProcess.pid) {
      this.sessionPid = gameProcess.pid;
      this.sessionReady = false;
      this.injectedIds.clear();
    }

    const inspections = [];
    for (const folderPath of activeModFolders) {
      const inspection = await this.inspectMod(folderPath, true);
      if (inspection) {
        inspections.push(inspection);
      }
    }
    if (!inspections.length) {
      this.setStatus({ phase: "inactive", label: "Inactive", message: "No active native mods", loaded: 0, total: 0, mods: [] });
      return;
    }
    if (inspections.length > 1) {
      this.setStatus({
        phase: "blocked",
        label: "Blocked",
        message: "This runtime version supports one active native mod at a time",
        loaded: this.injectedIds.size,
        total: inspections.length,
        mods: inspections.map((item) => this.publicInspection(item))
      });
      return;
    }

    const blocked = inspections.find((item) => item.phase !== "ready");
    if (blocked) {
      this.setStatus({
        phase: "blocked",
        label: "Blocked",
        message: `${blocked.displayName || blocked.id || "Native mod"}: ${blocked.message}`,
        loaded: this.injectedIds.size,
        total: inspections.length,
        mods: inspections.map((item) => this.publicInspection(item))
      });
      return;
    }

    const loadedModulePaths = new Set(
      (Array.isArray(gameProcess.nativeModules) ? gameProcess.nativeModules : gameProcess.nativeModules ? [gameProcess.nativeModules] : [])
        .map((modulePath) => path.normalize(modulePath).toLowerCase())
    );
    for (const inspection of inspections) {
      const expectedModule = path.join(this.getStageRoot(inspection), STAGED_PAYLOAD_NAME).toLowerCase();
      if (loadedModulePaths.has(path.normalize(expectedModule))) {
        this.injectedIds.add(inspection.id);
      }
    }

    if (!(await this.isGameReady(gameProcess))) {
      this.setStatus({
        phase: "waiting",
        label: "Waiting",
        message: "Waiting for the Bellwright main menu",
        loaded: this.injectedIds.size,
        total: inspections.length,
        mods: inspections.map((item) => this.publicInspection(item))
      });
      return;
    }

    const gameHash = await this.hashFile(gameProcess.path);
    for (const inspection of inspections) {
      const trusted = TRUSTED_NATIVE_MODS.get(inspection.id);
      if (!trusted.gameHashes.has(gameHash)) {
        this.setStatus({
          phase: "incompatible",
          label: "Update required",
          message: `${inspection.displayName || inspection.id} does not support this Bellwright build`,
          loaded: this.injectedIds.size,
          total: inspections.length,
          mods: inspections.map((item) => this.publicInspection(item))
        });
        return;
      }
    }

    const pending = inspections.filter((inspection) => !this.injectedIds.has(inspection.id));
    if (!pending.length) {
      this.setStatus({
        phase: "loaded",
        label: "Loaded",
        message: `${inspections.length} native mod${inspections.length === 1 ? "" : "s"} loaded in Bellwright PID ${gameProcess.pid}`,
        loaded: inspections.length,
        total: inspections.length,
        mods: inspections.map((item) => ({ ...this.publicInspection(item), phase: "loaded", label: "Runtime loaded" }))
      });
      return;
    }

    this.setStatus({
      phase: "loading",
      label: "Loading",
      message: `Loading ${pending[0].displayName || pending[0].id}`,
      loaded: this.injectedIds.size,
      total: inspections.length,
      mods: inspections.map((item) => this.publicInspection(item))
    });

    try {
      for (const inspection of pending) {
        await this.stageAndInject(inspection);
        this.injectedIds.add(inspection.id);
      }
      this.setStatus({
        phase: "loaded",
        label: "Loaded",
        message: `${inspections.length} native mod${inspections.length === 1 ? "" : "s"} loaded in Bellwright PID ${gameProcess.pid}`,
        loaded: inspections.length,
        total: inspections.length,
        mods: inspections.map((item) => ({ ...this.publicInspection(item), phase: "loaded", label: "Runtime loaded" }))
      });
    } catch (error) {
      this.setStatus({
        phase: "failed",
        label: "Failed",
        message: error.message || String(error),
        loaded: this.injectedIds.size,
        total: inspections.length,
        mods: inspections.map((item) => this.publicInspection(item))
      });
    }
  }
}

module.exports = {
  MANIFEST_FILE,
  NativeRuntimeManager
};
