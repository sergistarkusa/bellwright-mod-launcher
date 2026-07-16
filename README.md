# Bellwright Mod Launcher

Small Windows launcher for managing Bellwright local and Steam Workshop mods.

It shows installed mods in two compact columns:

- **Available**: installed but disabled mods
- **Active**: mods currently loaded by Bellwright

Drag a mod between columns or use the row action button to enable/disable it. The launcher detects Bellwright's Steam library, local `Content/Mods`, and Workshop folder for app id `1812450`.

## Features

- Manage local Bellwright mods and subscribed Steam Workshop mods.
- Keep disabled local and Workshop mods in reversible launcher-managed folders.
- Keep Workshop mods disabled after Steam downloads an updated copy, replacing the stale disabled files with the update.
- Prevent mod changes while Bellwright is running.
- Refresh the running/closed game state automatically.
- Open the Bellwright mods folder.
- Launch Bellwright through Steam.
- Load trusted native runtime mods automatically after Bellwright reaches the main menu, even if the launcher window is closed while the game starts.
- Block modified, unknown, or game-incompatible native payloads before execution.
- Save and load named active-mod presets, including load order.
- Configure compatible asset and trusted native mods from a launcher-provided settings menu, with no script extender required.
- Preserve selected mod options in named and shared presets and restore them after Workshop updates.
- Share presets as compact `BWL1` codes and preview imported mod availability before saving.
- Change active mod load priority through Bellwright's `modloadorder.json`.
- Show active mod conflicts from shared assets listed in `modinfo.json`.
- Update the launcher from the latest GitHub Release with visible download progress.
- Join the Bellwright Discord section from the app.
- Support FSD Software through Ko-fi.

## Download

Use the latest Windows portable ZIP from the GitHub Releases page.

Unzip it anywhere and run `BellwrightModLauncher.exe` from the stable `BellwrightModLauncher` folder. The downloaded ZIP filename contains the release version; the application folder does not.

**Upgrading from v0.5.2 or older:** close the old launcher, download v0.5.3 or newer manually, extract it, and run the new executable once. Older builds may download an update successfully but lose the installer when Electron exits. Automatic updates use the repaired post-exit handoff from v0.5.3 onward.

**Native mod users should install v0.5.6 or newer.** The launcher remains active in the background until native runtime loading is complete, stages verified per-mod configuration beside trusted payloads, and exits automatically when Bellwright closes. Starting the launcher executable again restores its window. Version 0.5.6 also fixes a Windows portable-update lock that could leave a downloaded update unapplied.

See [CHANGELOG.md](CHANGELOG.md) for release details.

## Notes

This is an unofficial community tool and is not affiliated with Donkey Crew, Snail Games, or Steam.

The launcher moves mod folders between active and disabled locations, updates `modinfo.json` active flags when possible, and keeps disabled local mods outside `Content/Mods` so Bellwright does not mount them accidentally. Close Bellwright before changing mod state or load order.

Trusted native mods include a `native-runtime.json` manifest. The launcher verifies the payload hash and current Bellwright executable, stages the DLL in its private runtime cache, and uses its bundled injector only after the main menu has loaded. Workshop packages cannot provide their own executable injector.

Bellwright must be started while the launcher is running whenever a native mod is enabled. Launching the game directly from Steam while the launcher is not running cannot load native Workshop payloads. Launching through the launcher is the supported path.

Version 0.4.0 intentionally allows one active native mod at a time. A later shared host can safely multiplex several native plugins without relying on Windows to distinguish identically named staged DLLs.

Presets store the currently active local and Workshop mods by folder/source, load order, and compatible launcher settings. Loading a preset changes the active mod set, options, and priority order to match it, so Bellwright must be closed.

Compatible mods can ship a schema-versioned `launcher-settings.json` plus signed package or bounded `.cfg` variants inside their own folder. Variant payloads use a non-mountable `.variant` suffix until selected. The launcher validates every declared path and SHA-256 hash, stages the complete replacement set, and rolls back if a swap fails. Trusted native configs are copied beside the verified payload before injection. Settings are never changed while Bellwright is running. Before launch, saved choices are reapplied when a Workshop update has restored the default package.

Conflict details are based on the asset metadata supplied by each mod's `modinfo.json`. They identify likely asset-level conflicts, but they cannot prove every possible gameplay or Blueprint logic conflict.

The update button checks the latest GitHub Release. When a newer portable ZIP is available, the launcher downloads it, stages it, then asks to restart and applies a clean folder replacement before launching the new version.

## Build From Source

Requirements:

- Node.js
- npm
- Windows

```powershell
npm install
npm start
npm run package:win
```

The packaged ZIP is written to `release/`.
