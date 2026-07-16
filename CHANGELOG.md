# Changelog

## [0.5.7] - 2026-07-16

- Changed the public author identity and launcher interface branding to ExcelsiorOne.
- Added the new Settlement Immigration runtime namespace while retaining a non-public legacy compatibility alias for cached older manifests.

## [0.5.6] - 2026-07-16

- Fixed Windows self-updates failing after download because the updater inherited the launcher's installation folder as its working directory.
- The updater now moves to its staging folder before replacing the portable installation.
- New portable archives keep the version in the ZIP filename while using the stable internal folder name `BellwrightModLauncher`.
- Versions through v0.5.5 may require this one manual download because their old updater cannot install its own repair.

## [0.5.5] - 2026-07-16

- Added launcher-controlled configuration files for trusted native mods without changing their verified payload.
- Added ten exact Settlement Immigration presets: 1 through 10 newcomers per in-game day.
- Give every scheduled newcomer a separate random arrival time between 07:00 and 22:59.
- Added trust and compatibility support for Bellwright Steam build 24204729.
- Check the installed Bellwright executable before launch and show native-mod incompatibility on the affected card instead of claiming the payload is ready.
- Verify and stage native configuration beside the trusted payload before injection.
- Added regression coverage for native runtime config variants and pre-launch compatibility reporting.

## [0.5.4] - 2026-07-15

- Fixed native mods silently failing when the launcher window was closed before Bellwright reached the main menu.
- Keep the native-runtime watcher alive in the background while Bellwright is starting or running, then exit automatically after the game closes.
- Reopen the launcher window when its executable is started again while the background watcher is active.
- Show the Bellwright process ID in the loaded native-runtime status for unambiguous session verification.
- Added regression coverage for pending injection, background shutdown, and reopening the hidden launcher.

## [0.5.3] - 2026-07-14

- Fixed the downloaded update installer being terminated together with Electron before it could replace the launcher folder.
- Replaced the detached child-process handoff with Electron's post-exit relaunch mechanism.
- Added regression coverage for the updater handoff and verified a complete v0.5.1-to-v0.5.2 replacement on a disposable installation.
- Versions through v0.5.2 may require one manual download of v0.5.3; automatic updates use the repaired handoff from v0.5.3 onward.

## [0.5.2] - 2026-07-14

- Added trust for the repaired Settlement Immigration v1.0.1 native payload.
- Removed trust for the faulty v1.0.0 payload so the launcher cannot load the known crashing build.

## [0.5.1] - 2026-07-12

- Fixed the updater crashing with `TypeError: crypto.randomBytes is not a function` before downloading a release.
- Added regression coverage requiring the main process to use Node's explicit `node:crypto` implementation.
- Versions through v0.5.0 require one manual download of v0.5.1 because the broken updater fails before it can install its own repair. Automatic updates work again from v0.5.1 onward.

## [0.5.0] - 2026-07-12

- Fixed large mod collections making the entire launcher and its text microscopically small.
- Replaced global auto-scaling with independently scrollable Available and Active columns.
- Compacted the static header, status, search, and preset controls to leave substantially more room for mod lists.
- Stabilized card columns so badges and optional settings no longer shift action buttons or wrap mod titles.
- Added Chromium layout regression checks for 10, 50, 100, and 200 active mods.
- Added a settings button for compatible asset-only mods.
- Added schema-versioned signed package variants with SHA-256 verification, atomic staging, and rollback.
- Blocked settings changes while Bellwright is running.
- Saved mod settings in local presets and shared `BWL1` preset codes.
- Reapplied saved settings before game launch when a Workshop update restored default files.
- Added four automated safety and switching tests for the variant system.

## [0.4.1] - 2026-07-10

- Fixed launcher updates that could close without installing or restarting.
- Isolated each download in a unique staging folder to avoid locked-file failures on retry.
- Waits for the complete old launcher process tree before atomically replacing the installation.
- Preserves an external update log and restores the previous installation if activation fails.
- Upgrading from v0.3.0 or v0.4.0 requires one manual download because their updater exits before its installer process starts; updates from v0.4.1 onward are automatic again.

## [0.4.0] - 2026-07-10

- Added trusted native runtime mod manifests and payload integrity checks.
- Added Bellwright build compatibility checks before native code is loaded.
- Added automatic main-menu injection through a launcher-bundled injector.
- Added native runtime status to the dashboard and individual mod cards.
- Workshop mods cannot supply executable injectors; unknown native payloads are blocked.

## [0.3.0] - 2026-07-07

### Highlights

- Share complete mod presets as compact `BWL1` codes.
- Preview an imported preset before saving it, including exact load order and installed or missing mod status.
- Open missing Steam Workshop mods directly from the import preview.
- Reorder active mods with arrow controls or drag and drop. Presets now preserve that order.
- Detect likely asset conflicts and show concise details from the warning icon on each affected mod.

### Reliability

- Disabled Workshop mods now stay disabled when Steam downloads an updated copy.
- A fresh Workshop update safely replaces the stale disabled copy instead of producing a `Target already exists` error.
- Loading an incomplete preset is blocked before any active mods are changed.
- Disabled local mods are kept outside `Content/Mods` so Bellwright cannot mount them accidentally.
- The launcher automatically follows Bellwright's running and closed state, even while its window is in the background.
- Mod state, `modinfo.json`, and `modloadorder.json` are kept in sync when mods are enabled, disabled, reordered, or loaded from a preset.

### Interface

- Replaced the blue Windows frame with a compact custom title bar and native-style minimize and close controls.
- Added automatic content fitting so the main window no longer needs a page scrollbar.
- Added cursor-following conflict tooltips without adding another section to the main screen.
- Kept sharing and importing inside the existing preset toolbar to avoid clutter.

### Notes

- Shared presets contain mod identifiers and load order, not mod files.
- Local mods that are missing on the receiving computer are clearly marked and must be installed separately.
- Conflict detection uses asset metadata from each mod's `modinfo.json`; it cannot detect every possible gameplay or Blueprint logic conflict.

### Links

- [Download from GitHub Releases](https://github.com/sergistarkusa/bellwright-mod-launcher/releases)
- [Join the Discord](https://discord.gg/Nnqt8S2r7n)
- [Support development on Ko-fi](https://ko-fi.com/excelsiorone)

## [0.2.0] - 2026-07-03

- Added named preset saving and loading.
- Added self-update checks, download progress, and clean restart-to-apply updates from GitHub Releases.

## [0.1.2] - 2026-07-01

- Initial public release of Bellwright Mod Launcher.
