const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const projectRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(projectRoot, "test", "fixtures", "large-list.html");
const artifactRoot = path.resolve(projectRoot, "..", "_build", "LauncherLayoutTests");
const scenarios = [
  { width: 900, height: 640, active: 10 },
  { width: 900, height: 640, active: 50 },
  { width: 1120, height: 760, active: 100 },
  { width: 1440, height: 900, active: 200 }
];

async function measure(window, scenario) {
  window.setSize(scenario.width, scenario.height);
  await window.loadFile(fixturePath, {
    query: { active: String(scenario.active), available: "25" }
  });
  return window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.shell');
    const topbar = document.querySelector('.topbar');
    const statusStrip = document.querySelector('.statusStrip');
    const controls = document.querySelector('.controls');
    const board = document.querySelector('.board');
    const active = document.querySelector('#activeList');
    const available = document.querySelector('#availableList');
    const card = active.querySelector('.modCard');
    const title = card.querySelector('.modTitle h2');
    const updateBadge = document.querySelector('.updateAvailabilityBadge');
    active.scrollTop = Math.min(300, active.scrollHeight);
    return {
      innerWidth,
      innerHeight,
      devicePixelRatio,
      shellBottom: shell.getBoundingClientRect().bottom,
      topbarHeight: topbar.getBoundingClientRect().height,
      statusHeight: statusStrip.getBoundingClientRect().height,
      controlsHeight: controls.getBoundingClientRect().height,
      controlsClientWidth: controls.clientWidth,
      controlsScrollWidth: controls.scrollWidth,
      boardBottom: board.getBoundingClientRect().bottom,
      boardHeight: board.getBoundingClientRect().height,
      cardHeight: card.getBoundingClientRect().height,
      cardClientWidth: card.clientWidth,
      cardScrollWidth: card.scrollWidth,
      titleHeight: title.getBoundingClientRect().height,
      titleFontSize: parseFloat(getComputedStyle(title).fontSize),
      shellZoom: getComputedStyle(shell).zoom || '1',
      activeClientHeight: active.clientHeight,
      activeScrollHeight: active.scrollHeight,
      activeScrollTop: active.scrollTop,
      availableScrollTop: available.scrollTop,
      updateBadgeDisplay: getComputedStyle(updateBadge).display,
      updateBadgeWidth: updateBadge.getBoundingClientRect().width,
      updateBadgeHeight: updateBadge.getBoundingClientRect().height
    };
  })()`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    show: false,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const results = [];
  try {
    for (const scenario of scenarios) {
      const metrics = await measure(window, scenario);
      assert.equal(metrics.shellZoom, "1", `unexpected zoom for ${JSON.stringify(scenario)}`);
      assert.ok(metrics.titleFontSize >= 12, `title text became too small: ${metrics.titleFontSize}px`);
      assert.ok(metrics.cardHeight >= 42, `card became too small: ${metrics.cardHeight}px`);
      assert.ok(metrics.titleHeight <= 17, `mod title wrapped to another line: ${metrics.titleHeight}px`);
      assert.ok(metrics.cardScrollWidth <= metrics.cardClientWidth + 1, "card controls overflow horizontally");
      assert.ok(metrics.controlsScrollWidth <= metrics.controlsClientWidth + 1, "static controls overflow horizontally");
      assert.notEqual(metrics.updateBadgeDisplay, "none", "update-available badge is hidden");
      assert.ok(metrics.updateBadgeWidth >= 14 && metrics.updateBadgeWidth <= 20, `unexpected update badge width: ${metrics.updateBadgeWidth}px`);
      assert.ok(metrics.updateBadgeHeight >= 14 && metrics.updateBadgeHeight <= 20, `unexpected update badge height: ${metrics.updateBadgeHeight}px`);
      assert.ok(metrics.boardHeight >= 120, `board became unusably short: ${metrics.boardHeight}px`);
      assert.ok(metrics.topbarHeight >= 78, `top bar collapsed: ${metrics.topbarHeight}px`);
      assert.ok(metrics.statusHeight >= 42, `status strip collapsed: ${metrics.statusHeight}px`);
      assert.ok(metrics.controlsHeight >= 36, `controls collapsed: ${metrics.controlsHeight}px`);
      assert.ok(metrics.shellBottom <= metrics.innerHeight + 1, "shell overflows the viewport");
      assert.ok(metrics.boardBottom <= metrics.innerHeight + 1, "board overflows the viewport");
      if (scenario.active >= 50) {
        assert.ok(metrics.activeScrollHeight > metrics.activeClientHeight, "large active list does not scroll");
        assert.ok(metrics.activeScrollTop > 0, "active list did not accept independent scrolling");
        assert.equal(metrics.availableScrollTop, 0, "scrolling active list moved available list");
      }
      results.push({ ...scenario, ...metrics });
    }
    await fs.mkdir(artifactRoot, { recursive: true });
    window.setSize(1120, 760);
    await window.loadFile(fixturePath, { query: { active: "200", available: "25" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const screenshot = await window.webContents.capturePage();
    await fs.writeFile(path.join(artifactRoot, "large-list-200.png"), screenshot.toPNG());
    console.log(JSON.stringify(results, null, 2));
    console.log(`Screenshot: ${path.join(artifactRoot, "large-list-200.png")}`);
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
  }
});
