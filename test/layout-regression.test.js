const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer", "renderer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer", "styles.css"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const packageScript = fs.readFileSync(path.join(root, "scripts", "package-windows.ps1"), "utf8");
const index = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
const updater = fs.readFileSync(path.join(root, "runtime", "apply-update.ps1"), "utf8");

test("updater uses Node crypto instead of Electron's Web Crypto global", () => {
  assert.match(main, /const nodeCrypto = require\("node:crypto"\);/);
  assert.match(main, /nodeCrypto\.randomBytes\(4\)/);
  assert.doesNotMatch(main, /(?<!nodeCrypto\.)crypto\.randomBytes\(/);
});

test("updater is relaunched after Electron exits instead of dying as its child", () => {
  const handoff = main.match(/async function startUpdaterAndQuit[\s\S]*?\n}\n\nasync function updateLauncher/)?.[0] || "";
  assert.match(handoff, /app\.relaunch\(\{/);
  assert.match(handoff, /execPath: powershellPath/);
  assert.match(handoff, /app\.exit\(0\)/);
  assert.doesNotMatch(handoff, /childProcess\.spawn/);
});

test("updater leaves the installation directory before renaming it", () => {
  assert.match(updater, /Set-Location -LiteralPath \$updaterWorkingDir/);
  assert.match(updater, /Set-Location -LiteralPath \(\[System\.IO\.Path\]::GetTempPath\(\)\)/);
  assert.ok(
    updater.indexOf("Set-Location -LiteralPath $updaterWorkingDir")
      < updater.indexOf("Get-ChildItem -LiteralPath $install -Force"),
    "the updater must release its inherited working-directory handle before touching the install"
  );
});

test("updater replaces contents without renaming the stable installation folder", () => {
  assert.doesNotMatch(updater, /Rename-Item -LiteralPath \$install/);
  assert.match(updater, /Clearing the current installation/);
  assert.match(updater, /Copy-Item -Destination \$install -Recurse -Force/);
  assert.match(updater, /Copy-Item -Destination \$backup -Recurse -Force/);
});

test("portable archive is versioned but its application folder is stable", () => {
  assert.match(packageScript, /\$archiveName = "BellwrightModLauncher-v\$version-win-x64-portable"/);
  assert.match(packageScript, /\$appFolderName = "BellwrightModLauncher"/);
  assert.match(packageScript, /\$zipPath = Join-Path \$releaseRoot "\$archiveName\.zip"/);
  assert.doesNotMatch(packageScript, /\$outDir = Join-Path \$distRoot \$archiveName/);
});

test("public launcher branding uses ExcelsiorOne", () => {
  const retiredBrand = ["FSD", "Software"].join(" ");
  assert.match(main, /maker: "ExcelsiorOne"/);
  assert.match(renderer, /Support ExcelsiorOne/);
  assert.match(index, /aria-label="ExcelsiorOne"/);
  assert.match(license, /Copyright \(c\) 2026 ExcelsiorOne/);
  assert.doesNotMatch([main, renderer, index, license].join("\n"), new RegExp(retiredBrand, "i"));
});

test("never scales the complete launcher to fit the mod count", () => {
  assert.doesNotMatch(renderer, /\.style\.zoom|fitContentToWindow|--content-scale/);
  assert.doesNotMatch(renderer, /devicePixelRatio/);
});

test("large mod lists scroll independently without shrinking cards", () => {
  assert.match(styles, /\.shell\s*\{[^}]*height:\s*calc\(100vh\s*-\s*50px\)/s);
  assert.match(styles, /\.board\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.modColumn\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.columnList\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.modCard\s*\{[^}]*min-height:\s*42px/s);
  assert.match(styles, /\.topbar,[\s\S]*\.statusStrip,[\s\S]*\.controls,[\s\S]*\.updateProgress\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
});

test("large-list visual fixture exercises 200 active mods", () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "large-list.html"), "utf8");
  assert.match(fixture, /activeCount\s*=\s*Number\(params\.get\("active"\)\s*\|\|\s*200\)/);
});
