const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  readProcEnviron,
  findProtonEnv,
  resolveProtonScriptPath,
  toWineDosPath,
  runNativeInjectorOnLinux
} = require("../linux-proton");

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFakeEnviron(procRoot, pid, envObject) {
  const pidDir = path.join(procRoot, String(pid));
  await fs.mkdir(pidDir, { recursive: true });
  const raw = Object.entries(envObject)
    .map(([key, value]) => `${key}=${value}`)
    .join("\0") + "\0";
  await fs.writeFile(path.join(pidDir, "environ"), raw, "utf8");
}

test("toWineDosPath converts an absolute Linux path to the Z: drive", () => {
  assert.equal(toWineDosPath("/home/user/Mods/thing/payload.dll"), "Z:\\home\\user\\Mods\\thing\\payload.dll");
});

test("readProcEnviron parses NUL-separated KEY=VALUE pairs, including values containing '='", async (t) => {
  const procRoot = await makeTempDir("bellwright-environ-");
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
  await writeFakeEnviron(procRoot, 111, {
    PATH: "/usr/bin:/bin",
    WINEPREFIX: "/home/user/.steam/steam/steamapps/compatdata/1812450/pfx",
    SOME_FLAG: "a=b=c"
  });

  const env = await readProcEnviron(111, procRoot);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.WINEPREFIX, "/home/user/.steam/steam/steamapps/compatdata/1812450/pfx");
  assert.equal(env.SOME_FLAG, "a=b=c");
});

test("findProtonEnv rejects a process with no STEAM_COMPAT_DATA_PATH", async (t) => {
  const procRoot = await makeTempDir("bellwright-environ-non-proton-");
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
  await writeFakeEnviron(procRoot, 222, { PATH: "/usr/bin" });

  await assert.rejects(() => findProtonEnv(222, procRoot), /not running under Proton/);
});

test("findProtonEnv captures Proton/Wine env vars and drops unrelated ones", async (t) => {
  const procRoot = await makeTempDir("bellwright-environ-proton-");
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
  await writeFakeEnviron(procRoot, 333, {
    STEAM_COMPAT_DATA_PATH: "/home/user/.steam/steam/steamapps/compatdata/1812450",
    STEAM_COMPAT_TOOL_PATHS: "/home/user/.steam/steam/steamapps/common/Proton 9.0",
    WINEPREFIX: "/home/user/.steam/steam/steamapps/compatdata/1812450/pfx",
    PROTON_USE_WINED3D: "0",
    SHLVL: "2",
    RANDOM_UNRELATED_VAR: "should-not-appear"
  });

  const env = await findProtonEnv(333, procRoot);
  assert.equal(env.STEAM_COMPAT_DATA_PATH, "/home/user/.steam/steam/steamapps/compatdata/1812450");
  assert.equal(env.WINEPREFIX, "/home/user/.steam/steam/steamapps/compatdata/1812450/pfx");
  assert.equal(env.PROTON_USE_WINED3D, "0");
  assert.equal(env.RANDOM_UNRELATED_VAR, undefined);
  assert.equal(env.SHLVL, undefined);
});

test("resolveProtonScriptPath finds the proton launcher script among several tool paths", async (t) => {
  const root = await makeTempDir("bellwright-proton-tools-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const emptyToolDir = path.join(root, "SteamLinuxRuntime");
  const protonDir = path.join(root, "Proton 9.0");
  await fs.mkdir(emptyToolDir, { recursive: true });
  await fs.mkdir(protonDir, { recursive: true });
  await fs.writeFile(path.join(protonDir, "proton"), "#!/bin/sh\n", { mode: 0o755 });

  const found = await resolveProtonScriptPath({
    STEAM_COMPAT_TOOL_PATHS: `${emptyToolDir}:${protonDir}`
  });
  assert.equal(found, path.join(protonDir, "proton"));
});

test("resolveProtonScriptPath returns null when no candidate directory has a proton script", async () => {
  const found = await resolveProtonScriptPath({ STEAM_COMPAT_TOOL_PATHS: "/nonexistent/path" });
  assert.equal(found, null);
});

test("runNativeInjectorOnLinux launches the resolved proton script with 'run <injector>' and the captured env", async (t) => {
  const root = await makeTempDir("bellwright-injector-run-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const procRoot = path.join(root, "proc");
  const protonDir = path.join(root, "Proton 9.0");
  const captureFile = path.join(root, "captured-args.txt");
  await fs.mkdir(protonDir, { recursive: true });

  // Stand in for the real Proton script: record argv and the env vars this
  // module is responsible for propagating, instead of actually starting Wine.
  const fakeProtonScript = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${captureFile}"`,
    `printf 'ENV BELLWRIGHT_NATIVE_PAYLOAD=%s\\n' "$BELLWRIGHT_NATIVE_PAYLOAD" >> "${captureFile}"`,
    `printf 'ENV WINEPREFIX=%s\\n' "$WINEPREFIX" >> "${captureFile}"`,
    ""
  ].join("\n");
  const protonScriptPath = path.join(protonDir, "proton");
  await fs.writeFile(protonScriptPath, fakeProtonScript, { mode: 0o755 });

  await writeFakeEnviron(procRoot, 4242, {
    STEAM_COMPAT_DATA_PATH: "/home/user/.steam/steam/steamapps/compatdata/1812450",
    STEAM_COMPAT_TOOL_PATHS: protonDir,
    WINEPREFIX: "/home/user/.steam/steam/steamapps/compatdata/1812450/pfx"
  });

  await runNativeInjectorOnLinux("/opt/launcher/runtime/BellwrightNativeInjector.exe", "/home/user/Mods/thing/payload.dll", 4242, procRoot);

  const captured = await fs.readFile(captureFile, "utf8");
  assert.match(captured, /^run$/m);
  assert.match(captured, /^\/opt\/launcher\/runtime\/BellwrightNativeInjector\.exe$/m);
  assert.match(captured, /ENV BELLWRIGHT_NATIVE_PAYLOAD=Z:\\home\\user\\Mods\\thing\\payload\.dll/);
  assert.match(captured, /ENV WINEPREFIX=\/home\/user\/\.steam\/steam\/steamapps\/compatdata\/1812450\/pfx/);
});

test("runNativeInjectorOnLinux rejects when no Proton runtime can be located", async (t) => {
  const root = await makeTempDir("bellwright-injector-missing-proton-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const procRoot = path.join(root, "proc");

  await writeFakeEnviron(procRoot, 5151, {
    STEAM_COMPAT_DATA_PATH: "/home/user/.steam/steam/steamapps/compatdata/1812450",
    STEAM_COMPAT_TOOL_PATHS: "/nonexistent/tools"
  });

  await assert.rejects(
    () => runNativeInjectorOnLinux("/opt/injector.exe", "/tmp/payload.dll", 5151, procRoot),
    /Could not locate the Proton runtime/
  );
});
