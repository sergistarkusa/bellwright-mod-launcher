const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const childProcess = require("child_process");
const {
  normalizeHash,
  normalizeRuntimeSignature,
  normalizeSupportedGameHashes,
  verifyRuntimeManifestSignature
} = require("./native-signature");
const { discoverNativePayload, parsePortableExecutable } = require("./native-discovery");

const MANIFEST_FILE = "native-runtime.json";
const PREFERENCES_FILE = "native-runtime-preferences.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const GAME_HASH_PRE_HOTFIX = "5d77d16d59831f684dce32d513db9cdc671f6f78d5b67b44f4e8d7b8f816b3e1";
const GAME_HASH_HOTFIX_2026_07_16 = "a3adc853e56e8a707348027db70ec923909df5a06ab342b8de5f71fca4ea4251";

const SETTLEMENT_IMMIGRATION_TRUST = {
  publisher: "ExcelsiorOne",
  publicKeys: new Map([
    ["excelsiorone-native-2026-01", `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPz99HWrvJbeUwtCEsLgX56Qt+z7nyq7WwZ/sgAd35S0=
-----END PUBLIC KEY-----`]
  ]),
  payloadHashes: new Set([
    "4cd3f7d3b349cb678ff53e81bd66e8dcceb7d9cb87331a8906aabd3ef835c487",
    "059d0fc24713d668a014a0233780d53c74aec8ceb55107ac4ecd7d0c4a8ce223",
    "d73fb57dd1ccbfc0b786a6666f4019aa9e315d84e1e10754b32d5a442c735403",
    "456b2347f094a04cc34715dcd3169a6cebd21759cc8563aa94070333d5d26626"
  ]),
  gameHashesByPayload: new Map([
    ["4cd3f7d3b349cb678ff53e81bd66e8dcceb7d9cb87331a8906aabd3ef835c487", new Set([GAME_HASH_PRE_HOTFIX])],
    ["059d0fc24713d668a014a0233780d53c74aec8ceb55107ac4ecd7d0c4a8ce223", new Set([GAME_HASH_PRE_HOTFIX])],
    ["d73fb57dd1ccbfc0b786a6666f4019aa9e315d84e1e10754b32d5a442c735403", new Set([GAME_HASH_PRE_HOTFIX])],
    ["456b2347f094a04cc34715dcd3169a6cebd21759cc8563aa94070333d5d26626", new Set([GAME_HASH_HOTFIX_2026_07_16])]
  ])
};

const TRUSTED_NATIVE_MODS = new Map([
  ["excelsiorone.settlement-immigration", SETTLEMENT_IMMIGRATION_TRUST]
]);

// Updated whenever the generic injector is rebuilt. The injector itself is still
// pinned because it is executable code shipped by the launcher.
const BUNDLED_INJECTOR_HASH = "2fe26595350ed061df60d55a5b48f63f612ce4b6d813a858900f159da486345c";

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

function getSupportedGameHashes(trusted, payloadHash, verifiedGameHashes = []) {
  if (Array.isArray(verifiedGameHashes) && verifiedGameHashes.length) {
    return new Set(verifiedGameHashes);
  }
  if (trusted?.gameHashesByPayload instanceof Map) {
    return trusted.gameHashesByPayload.get(payloadHash) || new Set();
  }
  return trusted?.gameHashes || new Set();
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
    payload: typeof raw.payload === "string" ? raw.payload.trim().replace(/\\/g, "/") : "",
    payloadSha256: normalizeHash(raw.payloadSha256),
    config: typeof raw.config === "string" ? raw.config.trim().replace(/\\/g, "/") : "",
    loadStage: raw.loadStage === "startup" ? "startup" : "main-menu",
    healthLog: typeof raw.healthLog === "string" ? raw.healthLog.trim() : "",
    supportedGameSha256: normalizeSupportedGameHashes(raw.supportedGameSha256),
    signature: normalizeRuntimeSignature(raw.signature)
  };
}

function normalizePreference(raw) {
  const trust = raw?.trust === "item" || raw?.trust === "version" ? raw.trust : "";
  return {
    payload: typeof raw?.payload === "string" ? raw.payload.replace(/\\/g, "/") : "",
    trust,
    hash: normalizeHash(raw?.hash)
  };
}

function normalizedModulePath(value) {
  return path.normalize(String(value || "")).toLowerCase();
}

class NativeRuntimeManager {
  constructor(options) {
    this.userDataPath = options.userDataPath;
    this.bundledInjectorPath = options.bundledInjectorPath;
    this.gameLogPath = options.gameLogPath;
    this.resolveGameExecutablePath = options.resolveGameExecutablePath || (async () => null);
    this.trustedNativeMods = options.trustedNativeMods || TRUSTED_NATIVE_MODS;
    this.onStatusChanged = options.onStatusChanged || (() => {});
    this.hashCache = new Map();
    this.preferences = null;
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

  async hashFile(filePath, bypassCache = false) {
    const stat = await fs.stat(filePath);
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    if (!bypassCache && this.hashCache.has(cacheKey)) {
      return this.hashCache.get(cacheKey);
    }
    const hash = crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
    this.hashCache.set(cacheKey, hash);
    return hash;
  }

  getPreferencesPath() {
    return path.join(this.userDataPath, PREFERENCES_FILE);
  }

  async readPreferences() {
    if (this.preferences) {
      return this.preferences;
    }
    const raw = (await readJson(this.getPreferencesPath())) || {};
    const mods = raw.mods && typeof raw.mods === "object" && !Array.isArray(raw.mods)
      ? Object.fromEntries(Object.entries(raw.mods).map(([key, value]) => [key, normalizePreference(value)]))
      : {};
    this.preferences = { version: 1, mods };
    return this.preferences;
  }

  async writePreferences() {
    await fs.mkdir(this.userDataPath, { recursive: true });
    await fs.writeFile(this.getPreferencesPath(), `${JSON.stringify(this.preferences || { version: 1, mods: {} }, null, 2)}\n`, "utf8");
  }

  async updatePreference(identity, patch) {
    const store = await this.readPreferences();
    store.mods[identity] = normalizePreference({ ...store.mods[identity], ...patch });
    await this.writePreferences();
    return store.mods[identity];
  }

  async setPayloadSelection(identity, relativePath) {
    if (!identity || !relativePath || path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
      throw new Error("Invalid native payload selection.");
    }
    return this.updatePreference(identity, { payload: relativePath });
  }

  async approveNativeMod(identity, mode, payloadHash) {
    if (!identity || !["version", "item"].includes(mode)) {
      throw new Error("Invalid native runtime approval.");
    }
    return this.updatePreference(identity, { trust: mode, hash: mode === "version" ? payloadHash : "" });
  }

  async cleanupLegacyRuntimeCache() {
    await fs.rm(path.join(this.userDataPath, "native-runtime"), { recursive: true, force: true });
  }

  async readModInfo(folderPath) {
    const modInfo = (await readJson(path.join(folderPath, "modinfo.json"))) || {};
    return {
      title: typeof modInfo.title === "string" ? modInfo.title.trim() : "",
      folderName: typeof modInfo.folderName === "string" ? modInfo.folderName.trim() : "",
      author: typeof modInfo.author === "string" ? modInfo.author.trim() : "",
      steamId: Number.isFinite(Number(modInfo.steamId)) ? Math.trunc(Number(modInfo.steamId)) : 0
    };
  }

  getIdentity(folderPath) {
    const folderName = path.basename(folderPath);
    if (/^\d{6,}$/.test(folderName)) {
      return `workshop:${folderName}`;
    }
    return `local:${folderName.toLowerCase()}`;
  }

  async inspectExplicitPayload(folderPath, relativePath) {
    const payloadPath = resolveInside(folderPath, relativePath);
    if (!payloadPath || !(await exists(payloadPath))) {
      return null;
    }
    const realRoot = await fs.realpath(folderPath);
    const realPayloadPath = await fs.realpath(payloadPath);
    const realRelative = path.relative(realRoot, realPayloadPath);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return null;
    }
    const stat = await fs.stat(realPayloadPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024 * 1024) {
      return null;
    }
    const pe = parsePortableExecutable(await fs.readFile(realPayloadPath));
    if (!pe.isX64Dll) {
      return null;
    }
    return {
      path: realPayloadPath,
      relativePath: path.relative(folderPath, payloadPath).replace(/\\/g, "/"),
      imports: pe.imports,
      exports: pe.exports,
      size: stat.size
    };
  }

  async inspectMod(folderPath, active, gameExecutablePath = null) {
    const manifestPath = path.join(folderPath, MANIFEST_FILE);
    const rawManifest = await readJson(manifestPath);
    const manifest = normalizeManifest(rawManifest);
    const modInfo = await this.readModInfo(folderPath);
    const identity = this.getIdentity(folderPath);
    const preferences = await this.readPreferences();
    const preference = normalizePreference(preferences.mods[identity]);
    const displayName = manifest?.displayName || modInfo.title || modInfo.folderName || path.basename(folderPath);
    const publisher = manifest?.publisher || modInfo.author || "Unknown";
    const hints = [displayName, modInfo.folderName, path.basename(folderPath), identity];

    let discovery = null;
    if (manifest?.payload) {
      const explicit = await this.inspectExplicitPayload(folderPath, manifest.payload);
      if (explicit) {
        discovery = { selected: explicit, candidates: [explicit], reason: "manifest" };
      }
    }
    if (!discovery) {
      discovery = await discoverNativePayload(folderPath, hints, preference.payload);
    }
    if (!rawManifest && !discovery.selected && !discovery.candidates.length) {
      return null;
    }
    if (!discovery.selected && discovery.candidates.length) {
      return {
        schemaVersion: manifest?.schemaVersion || 0,
        id: manifest?.id || identity,
        identity,
        displayName,
        publisher,
        version: manifest?.version || "",
        phase: "selection-required",
        label: "Choose native DLL",
        message: "Multiple possible native entry DLLs were found",
        verified: false,
        approved: false,
        selectionRequired: true,
        candidatePayloads: discovery.candidates.map((candidate) => candidate.relativePath),
        detectionReason: discovery.reason
      };
    }
    if (!discovery.selected) {
      return {
        schemaVersion: manifest?.schemaVersion || 0,
        id: manifest?.id || identity,
        identity,
        displayName,
        publisher,
        version: manifest?.version || "",
        phase: "invalid",
        label: "Invalid native mod",
        message: "No x64 native payload DLL was found",
        verified: false,
        approved: false,
        candidatePayloads: []
      };
    }

    const payloadPath = discovery.selected.path;
    const payload = discovery.selected.relativePath;
    const actualHash = await this.hashFile(payloadPath);
    const normalized = manifest || normalizeManifest({});
    normalized.id = normalized.id || identity;
    normalized.displayName = displayName;
    normalized.publisher = publisher;
    normalized.payload = payload;

    const trusted = this.trustedNativeMods.get(normalized.id);
    const publisherMatches = Boolean(trusted) && (!trusted.publisher || trusted.publisher === normalized.publisher);
    const declaredHashMatches = Boolean(normalized.payloadSha256) && normalized.payloadSha256 === actualHash;
    const pinnedPayload = publisherMatches && declaredHashMatches &&
      trusted.payloadHashes instanceof Set && trusted.payloadHashes.has(actualHash);
    const signedPayload = publisherMatches && declaredHashMatches &&
      verifyRuntimeManifestSignature(normalized, trusted.publicKeys);
    const verified = Boolean(pinnedPayload || signedPayload);
    const signatureStatus = signedPayload ? "verified" : pinnedPayload ? "verified-legacy" : normalized.signature ? "invalid" : "unsigned";
    const verifiedGameHashes = signedPayload ? normalized.supportedGameSha256 : [];
    const approved = verified || preference.trust === "item" ||
      (preference.trust === "version" && preference.hash === actualHash);

    let configPath = null;
    if (normalized.config) {
      configPath = resolveInside(folderPath, normalized.config);
      const realRoot = await fs.realpath(folderPath);
      const realConfigPath = configPath ? await fs.realpath(configPath).catch(() => null) : null;
      const realConfigRelative = realConfigPath ? path.relative(realRoot, realConfigPath) : "..";
      if (realConfigRelative.startsWith("..") || path.isAbsolute(realConfigRelative)) {
        configPath = null;
      } else {
        configPath = realConfigPath;
      }
      const configStat = configPath ? await fs.stat(configPath).catch(() => null) : null;
      if (!configStat?.isFile() || configStat.size > MAX_CONFIG_BYTES) {
        return {
          ...normalized,
          id: normalized.id,
          identity,
          displayName,
          publisher,
          payload,
          phase: "invalid",
          label: "Invalid config",
          message: "The native runtime config file is missing or invalid",
          verified,
          approved,
          signatureStatus,
          candidatePayloads: discovery.candidates.map((candidate) => candidate.relativePath)
        };
      }
    }

    if (active && verified) {
      const installedGameExecutablePath = gameExecutablePath || await this.resolveGameExecutablePath();
      if (installedGameExecutablePath && (await exists(installedGameExecutablePath))) {
        const gameHash = await this.hashFile(installedGameExecutablePath);
        const supportedGameHashes = getSupportedGameHashes(trusted, actualHash, verifiedGameHashes);
        if (supportedGameHashes.size && !supportedGameHashes.has(gameHash)) {
          return {
            ...normalized,
            id: normalized.id,
            identity,
            displayName,
            publisher,
            payload,
            phase: "incompatible",
            label: "Update required",
            message: "This verified native mod does not support the installed Bellwright build",
            verified,
            approved,
            signatureStatus,
            payloadPath,
            actualHash,
            verifiedGameHashes,
            configPath,
            candidatePayloads: discovery.candidates.map((candidate) => candidate.relativePath),
            detectionReason: discovery.reason
          };
        }
      }
    }

    const phase = !active ? "disabled" : !approved ? "approval-required" : "ready";
    const label = verified ? "Verified native" : approved ? "Community native" : "Approval required";
    const message = verified
      ? "Verified native payload is ready to load directly from the mod folder"
      : approved
        ? "Community native payload is ready to load directly from the mod folder"
        : "This mod contains unverified native code and needs user approval";
    return {
      ...normalized,
      id: normalized.id,
      identity,
      displayName,
      publisher,
      payload,
      phase,
      label,
      message,
      verified,
      approved,
      approvalMode: verified ? "verified" : preference.trust,
      signatureStatus,
      payloadPath,
      actualHash,
      verifiedGameHashes,
      configPath,
      candidatePayloads: discovery.candidates.map((candidate) => candidate.relativePath),
      detectionReason: discovery.reason
    };
  }

  publicInspection(inspection) {
    if (!inspection) {
      return null;
    }
    const { payloadPath, configPath, verifiedGameHashes, ...publicFields } = inspection;
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

  async runInjector(payloadPath, targetPid) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(
        this.bundledInjectorPath,
        [],
        {
          windowsHide: true,
          timeout: 30000,
          env: {
            ...process.env,
            BELLWRIGHT_NATIVE_PAYLOAD: payloadPath,
            BELLWRIGHT_NATIVE_TARGET_PID: String(targetPid)
          }
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || stdout || error.message).trim()));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  async injectDirect(inspection, targetPid) {
    const injectorHash = await this.hashFile(this.bundledInjectorPath, true);
    if (injectorHash !== BUNDLED_INJECTOR_HASH) {
      throw new Error("Bundled native injector failed integrity verification");
    }
    const currentPayloadHash = await this.hashFile(inspection.payloadPath, true);
    if (currentPayloadHash !== inspection.actualHash) {
      throw new Error(`${inspection.displayName}: native payload changed before injection`);
    }
    await this.runInjector(inspection.payloadPath, targetPid);
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
      const inspection = await this.inspectMod(folderPath, true, gameProcess.path);
      if (inspection) {
        inspections.push(inspection);
      }
    }
    if (!inspections.length) {
      this.setStatus({ phase: "inactive", label: "Inactive", message: "No active native mods", loaded: 0, total: 0, mods: [] });
      return;
    }

    const loadedModulePaths = new Set(
      (Array.isArray(gameProcess.nativeModules) ? gameProcess.nativeModules : gameProcess.nativeModules ? [gameProcess.nativeModules] : [])
        .map(normalizedModulePath)
    );
    for (const inspection of inspections) {
      if (inspection.payloadPath && loadedModulePaths.has(normalizedModulePath(inspection.payloadPath))) {
        this.injectedIds.add(inspection.identity);
      }
    }

    const ready = inspections.filter((inspection) => inspection.phase === "ready");
    const blocked = inspections.filter((inspection) => inspection.phase !== "ready");
    const pending = ready.filter((inspection) => !this.injectedIds.has(inspection.identity));
    if (pending.length && !(await this.isGameReady(gameProcess))) {
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

    const failures = [];
    if (pending.length) {
      this.setStatus({
        phase: "loading",
        label: "Loading",
        message: `Loading ${pending[0].displayName || pending[0].id} directly from its mod folder`,
        loaded: this.injectedIds.size,
        total: inspections.length,
        mods: inspections.map((item) => this.publicInspection(item))
      });
      for (const inspection of pending) {
        try {
          await this.injectDirect(inspection, gameProcess.pid);
          this.injectedIds.add(inspection.identity);
        } catch (error) {
          failures.push({ inspection, message: error.message || String(error) });
        }
      }
    }

    const loaded = inspections.filter((inspection) => this.injectedIds.has(inspection.identity)).length;
    const publicMods = inspections.map((inspection) => {
      const failure = failures.find((item) => item.inspection.identity === inspection.identity);
      if (failure) {
        return { ...this.publicInspection(inspection), phase: "failed", label: "Failed", message: failure.message };
      }
      if (this.injectedIds.has(inspection.identity)) {
        return { ...this.publicInspection(inspection), phase: "loaded", label: inspection.verified ? "Verified loaded" : "Community loaded" };
      }
      return this.publicInspection(inspection);
    });

    if (failures.length || blocked.length) {
      const firstProblem = failures[0]?.message || blocked[0]?.message || "Native runtime approval is required";
      this.setStatus({
        phase: loaded ? "partial" : blocked.some((item) => item.phase === "approval-required") ? "approval-required" : "blocked",
        label: loaded ? "Partial" : blocked.some((item) => item.phase === "approval-required") ? "Approval required" : "Blocked",
        message: loaded ? `${loaded}/${inspections.length} native mods loaded; ${firstProblem}` : firstProblem,
        loaded,
        total: inspections.length,
        mods: publicMods
      });
      return;
    }

    this.setStatus({
      phase: "loaded",
      label: "Loaded",
      message: `${loaded} native mod${loaded === 1 ? "" : "s"} loaded in Bellwright PID ${gameProcess.pid}`,
      loaded,
      total: inspections.length,
      mods: publicMods
    });
  }
}

module.exports = {
  BUNDLED_INJECTOR_HASH,
  MANIFEST_FILE,
  NativeRuntimeManager
};
