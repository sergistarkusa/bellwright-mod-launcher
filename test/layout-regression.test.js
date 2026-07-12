const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer", "renderer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer", "styles.css"), "utf8");

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
