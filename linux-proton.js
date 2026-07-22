// Runs the bundled Windows native injector inside the Proton prefix that is
// already hosting the running Bellwright process. Bellwright under Proton is a
// normal PE process inside a Wine prefix, so the existing CreateRemoteThread +
// LoadLibraryW injector works unmodified once it is launched through `proton run`
// with that prefix's environment reconstructed from /proc/<pid>/environ.
const fs = require("fs/promises");
const path = require("path");
const childProcess = require("child_process");

// Env vars captured from the game's own process so the injector attaches to the
// same wineserver/prefix instead of spawning a new, unrelated one.
const PROTON_ENV_KEYS = [
  "STEAM_COMPAT_DATA_PATH",
  "STEAM_COMPAT_CLIENT_INSTALL_PATH",
  "STEAM_COMPAT_TOOL_PATHS",
  "STEAM_COMPAT_APP_ID",
  "STEAM_COMPAT_MOUNTS",
  "WINEPREFIX",
  "WINEFSYNC",
  "WINEESYNC",
  "WINEDLLOVERRIDES",
  "WINEDEBUG",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DXVK_LOG_LEVEL",
  "DXVK_STATE_CACHE_PATH"
];

async function readProcEnviron(pid, procRoot = "/proc") {
  const raw = await fs.readFile(path.join(procRoot, String(pid), "environ"));
  const env = {};
  for (const entry of raw.toString("utf8").split("\0")) {
    if (!entry) {
      continue;
    }
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    env[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
  }
  return env;
}

async function findProtonEnv(pid, procRoot = "/proc") {
  let processEnv;
  try {
    processEnv = await readProcEnviron(pid, procRoot);
  } catch (error) {
    throw new Error(`Could not read the environment of Bellwright process ${pid}: ${error.message}`);
  }
  if (!processEnv.STEAM_COMPAT_DATA_PATH) {
    throw new Error("Bellwright is not running under Proton (no STEAM_COMPAT_DATA_PATH found).");
  }
  const captured = {};
  for (const key of PROTON_ENV_KEYS) {
    if (processEnv[key] !== undefined) {
      captured[key] = processEnv[key];
    }
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (key.startsWith("PROTON_")) {
      captured[key] = value;
    }
  }
  return captured;
}

async function resolveProtonScriptPath(protonEnv) {
  const toolPaths = String(protonEnv.STEAM_COMPAT_TOOL_PATHS || "").split(":").filter(Boolean);
  for (const toolPath of toolPaths) {
    const candidate = path.join(toolPath, "proton");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Not the Proton install directory; keep looking.
    }
  }
  return null;
}

// Wine's default drive mapping exposes the whole Unix filesystem under Z:\, with
// path separators swapped. This is enough for an absolute mod-folder path.
function toWineDosPath(linuxPath) {
  return `Z:${linuxPath.replace(/\//g, "\\")}`;
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

// Signature matches native-runtime.js's runInjector override contract:
// (injectorPath, payloadPath, targetPid) -> Promise<stdout>.
async function runNativeInjectorOnLinux(injectorPath, payloadPath, targetPid, procRoot = "/proc") {
  const protonEnv = await findProtonEnv(targetPid, procRoot);
  const protonScriptPath = await resolveProtonScriptPath(protonEnv);
  if (!protonScriptPath) {
    throw new Error("Could not locate the Proton runtime used to launch Bellwright.");
  }
  const env = {
    ...process.env,
    ...protonEnv,
    BELLWRIGHT_NATIVE_PAYLOAD: toWineDosPath(payloadPath),
    // The Linux PID is not a Wine/Windows PID; the injector locates Bellwright by
    // process name inside the prefix, so this is intentionally not a real PID.
    BELLWRIGHT_NATIVE_TARGET_PID: "0"
  };
  return execFileAsync(protonScriptPath, ["run", injectorPath], { env, timeout: 30000 });
}

module.exports = {
  readProcEnviron,
  findProtonEnv,
  resolveProtonScriptPath,
  toWineDosPath,
  runNativeInjectorOnLinux
};
