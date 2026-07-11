# Changelog

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
