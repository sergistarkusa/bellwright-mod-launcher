// Linux-only helpers: Steam install discovery and /proc-based process inspection.
// Every function here accepts an injectable root (home dir / procfs root) so it can
// be exercised against fixture directories in tests without touching the real OS.
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const PID_DIR_PATTERN = /^\d+$/;

// Matches the priority order the Windows PowerShell process query already used:
// the shipping binary wins, the umbrella exe is next, everything else ties last.
const NAME_PRIORITY = new Map([
  ["bellwrightgame-win64-shipping.exe", 0],
  ["bellwrightgame.exe", 1]
]);

function rankForName(name) {
  return NAME_PRIORITY.get(String(name || "").toLowerCase()) ?? 2;
}

function getLinuxSteamRootCandidates(homeDir = os.homedir()) {
  return [
    path.join(homeDir, ".steam", "steam"),
    path.join(homeDir, ".steam", "root"),
    path.join(homeDir, ".local", "share", "Steam"),
    path.join(homeDir, ".steam", "debian-installation"),
    path.join(homeDir, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
    path.join(homeDir, "snap", "steam", "common", ".local", "share", "Steam")
  ];
}

async function resolveLinuxSteamRoots(homeDir = os.homedir()) {
  const roots = new Set();
  for (const candidate of getLinuxSteamRootCandidates(homeDir)) {
    roots.add(candidate);
    try {
      roots.add(await fs.realpath(candidate));
    } catch {
      // Candidate does not exist, or "root" is not a symlink on this install; ignore.
    }
  }
  return [...roots];
}

async function readPidDirectories(procRoot) {
  const entries = await fs.readdir(procRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && PID_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

async function readComm(procRoot, pid) {
  try {
    return (await fs.readFile(path.join(procRoot, pid, "comm"), "utf8")).trim();
  } catch {
    return "";
  }
}

async function readCmdline(procRoot, pid) {
  try {
    const raw = await fs.readFile(path.join(procRoot, pid, "cmdline"));
    return raw.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

async function readStartTimeIso(procRoot, pid) {
  try {
    const stat = await fs.stat(path.join(procRoot, pid));
    // /proc/<pid>'s own birth time is a close enough proxy for process start time;
    // it is only used for a "did the log predate the process" comparison.
    const startTimeMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
    return new Date(startTimeMs).toISOString();
  } catch {
    return null;
  }
}

async function readNativeModules(procRoot, pid) {
  try {
    const text = await fs.readFile(path.join(procRoot, pid, "maps"), "utf8");
    const modules = new Set();
    for (const line of text.split("\n")) {
      const fields = line.trim().split(/\s+/);
      const pathname = fields.length > 5 ? fields.slice(5).join(" ") : "";
      if (pathname.startsWith("/") && /\.dll$/i.test(pathname)) {
        modules.add(pathname);
      }
    }
    return [...modules];
  } catch {
    return [];
  }
}

// Finds the running Bellwright process by scanning /proc directly (no PowerShell
// equivalent exists on Linux). Matching mirrors the Windows Get-Process query:
// prefer an exact name seen in argv/cmdline, and fall back to comparing against
// /proc/<pid>/comm, which the kernel truncates to 15 visible characters.
async function findLinuxGameProcess({ names, expectedExecutablePath = null, procRoot = "/proc" }) {
  const candidateNames = [...names];
  const pids = await readPidDirectories(procRoot);
  const matches = [];

  for (const pid of pids) {
    const [comm, cmdline] = await Promise.all([readComm(procRoot, pid), readCmdline(procRoot, pid)]);
    if (!comm && !cmdline.length) {
      continue;
    }
    const joinedCmdline = cmdline.join(" ").toLowerCase();
    let matchedName = candidateNames.find((name) => joinedCmdline.includes(name.toLowerCase()));
    if (!matchedName && comm) {
      matchedName = candidateNames.find((name) => name.toLowerCase().slice(0, 15) === comm.toLowerCase());
    }
    if (!matchedName) {
      continue;
    }
    matches.push({ pid, matchedName });
  }

  if (!matches.length) {
    return null;
  }

  const withDetails = await Promise.all(
    matches.map(async (match) => ({
      ...match,
      startTime: await readStartTimeIso(procRoot, match.pid),
      nativeModules: await readNativeModules(procRoot, match.pid)
    }))
  );

  withDetails.sort((a, b) => {
    const rankDiff = rankForName(a.matchedName) - rankForName(b.matchedName);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return (Date.parse(b.startTime || "") || 0) - (Date.parse(a.startTime || "") || 0);
  });

  const best = withDetails[0];
  return {
    pid: Number(best.pid),
    path: expectedExecutablePath,
    startTime: best.startTime,
    nativeModules: best.nativeModules
  };
}

module.exports = {
  getLinuxSteamRootCandidates,
  resolveLinuxSteamRoots,
  findLinuxGameProcess
};
