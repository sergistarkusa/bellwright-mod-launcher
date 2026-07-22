const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  getLinuxSteamRootCandidates,
  resolveLinuxSteamRoots,
  findLinuxGameProcess
} = require("../linux-support");

const GAME_PROCESS_NAMES = [
  "Bellwright.exe",
  "BellwrightGame.exe",
  "BellwrightGame-Win64-Shipping.exe",
  "Bellwright-Win64-Shipping.exe"
];

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFakeProcess(procRoot, pid, { comm = "", cmdline = [], maps = "" } = {}) {
  const pidDir = path.join(procRoot, String(pid));
  await fs.mkdir(pidDir, { recursive: true });
  if (comm) {
    await fs.writeFile(path.join(pidDir, "comm"), `${comm}\n`, "utf8");
  }
  await fs.writeFile(path.join(pidDir, "cmdline"), cmdline.length ? `${cmdline.join("\0")}\0` : "", "utf8");
  await fs.writeFile(path.join(pidDir, "maps"), maps, "utf8");
}

test("getLinuxSteamRootCandidates lists native, Flatpak, and snap Steam locations", () => {
  const candidates = getLinuxSteamRootCandidates("/home/x");
  assert.ok(candidates.includes("/home/x/.steam/steam"));
  assert.ok(candidates.includes("/home/x/.steam/root"));
  assert.ok(candidates.includes("/home/x/.local/share/Steam"));
  assert.ok(candidates.includes("/home/x/.var/app/com.valvesoftware.Steam/data/Steam"));
  assert.ok(candidates.includes("/home/x/snap/steam/common/.local/share/Steam"));
});

test("resolveLinuxSteamRoots follows the ~/.steam/root symlink to its real target", async (t) => {
  const homeDir = await makeTempDir("bellwright-steam-home-");
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));

  const realSteamDir = path.join(homeDir, ".local", "share", "Steam");
  await fs.mkdir(realSteamDir, { recursive: true });
  await fs.mkdir(path.join(homeDir, ".steam"), { recursive: true });
  await fs.symlink(realSteamDir, path.join(homeDir, ".steam", "root"));

  const roots = await resolveLinuxSteamRoots(homeDir);
  assert.ok(roots.includes(path.join(homeDir, ".steam", "root")));
  assert.ok(roots.includes(realSteamDir));
});

test("findLinuxGameProcess matches the shipping binary by cmdline and reports its DLL modules", async (t) => {
  const procRoot = await makeTempDir("bellwright-proc-");
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));

  await writeFakeProcess(procRoot, 4242, {
    comm: "BellwrightGame-",
    cmdline: ["Z:\\game\\Binaries\\Win64\\BellwrightGame-Win64-Shipping.exe"],
    maps: [
      "7f0000000000-7f0000010000 r--p 00000000 00:00 0  ",
      "7f0000010000-7f0000020000 r-xp 00000000 00:00 0   /home/user/.steam/.../workshop/content/1812450/999/native/Mod.dll",
      "7f0000020000-7f0000030000 r--p 00000000 00:00 0   [heap]"
    ].join("\n")
  });
  // A decoy process that must not be matched.
  await writeFakeProcess(procRoot, 1, { comm: "systemd", cmdline: ["/sbin/init"] });

  const result = await findLinuxGameProcess({
    names: GAME_PROCESS_NAMES,
    expectedExecutablePath: "/home/user/Bellwright/Binaries/Win64/BellwrightGame-Win64-Shipping.exe",
    procRoot
  });

  assert.ok(result);
  assert.equal(result.pid, 4242);
  assert.equal(result.path, "/home/user/Bellwright/Binaries/Win64/BellwrightGame-Win64-Shipping.exe");
  assert.equal(result.nativeModules.length, 1);
  assert.match(result.nativeModules[0], /Mod\.dll$/);
});

test("findLinuxGameProcess prefers the shipping binary over the umbrella exe regardless of start time", async (t) => {
  const procRoot = await makeTempDir("bellwright-proc-priority-");
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));

  // Created first (so it is the older process), and it is the actual shipping
  // binary — it must win even though the umbrella exe below is newer.
  await writeFakeProcess(procRoot, 200, {
    comm: "BellwrightGame-",
    cmdline: ["Z:\\game\\Binaries\\Win64\\BellwrightGame-Win64-Shipping.exe"]
  });
  // Created second (so it is the newer process), but it is only the umbrella
  // "BellwrightGame.exe" — lower priority, must lose despite being newer.
  await writeFakeProcess(procRoot, 100, {
    comm: "BellwrightGame.e",
    cmdline: ["Z:\\game\\BellwrightGame.exe"]
  });

  const result = await findLinuxGameProcess({ names: GAME_PROCESS_NAMES, procRoot });
  assert.equal(result.pid, 200);
});

test("findLinuxGameProcess falls back to the truncated comm name when cmdline is unavailable", async (t) => {
  const procRoot = await makeTempDir("bellwright-proc-comm-");
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));

  await writeFakeProcess(procRoot, 555, { comm: "BellwrightGame-", cmdline: [] });

  const result = await findLinuxGameProcess({ names: GAME_PROCESS_NAMES, procRoot });
  assert.equal(result.pid, 555);
});

test("findLinuxGameProcess returns null when nothing matches", async (t) => {
  const procRoot = await makeTempDir("bellwright-proc-none-");
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));

  await writeFakeProcess(procRoot, 7, { comm: "bash", cmdline: ["/bin/bash"] });

  const result = await findLinuxGameProcess({ names: GAME_PROCESS_NAMES, procRoot });
  assert.equal(result, null);
});
