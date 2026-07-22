# Bellwright Mod Launcher

Small Windows and Linux launcher for managing Bellwright local and Steam Workshop mods.

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
- Load verified and community native runtime mods directly from their local or Steam Workshop folders after Bellwright reaches the main menu, even if the launcher window is closed while the game starts.
- Mark signed payloads as verified and require an explicit user warning before running unsigned community DLLs.
- Save and load named active-mod presets, including load order.
- Configure compatible asset and native mods from a launcher-provided settings menu, with no script extender required.
- Preserve selected mod options in named and shared presets and restore them after Workshop updates.
- Share presets as compact `BWL1` codes and preview imported mod availability before saving.
- Change active mod load priority through Bellwright's `modloadorder.json`.
- Show active mod conflicts from shared assets listed in `modinfo.json`.
- Check quietly for a newer launcher release, show an Update notification badge, and install it with visible download progress.
- Join the Bellwright Discord section from the app.
- Support ExcelsiorOne through Ko-fi.

## Download

Use the latest Windows portable ZIP from the GitHub Releases page.

Unzip it anywhere and run `BellwrightModLauncher.exe` from the stable `BellwrightModLauncher` folder. The downloaded ZIP filename contains the release version; the application folder does not.

**Upgrading from v0.5.8 or newer:** use the launcher's normal Update button. These versions already replace files inside the stable `BellwrightModLauncher` folder and can install v0.6.0 automatically. The transition itself still starts through the older hidden PowerShell handoff; after v0.6.0 is running, every later update uses the new GUI-safe handoff. Versions through v0.5.7 may require one final manual download because their older updater predates stable in-place replacement.

**Native mod users should install v0.6.0 or newer.** The launcher remains active in the background until native runtime loading is complete, loads each approved DLL directly from its mod folder, and exits automatically when Bellwright closes. Starting the launcher executable again restores its window.

## Notes

This is an unofficial community tool and is not affiliated with Donkey Crew, Snail Games, or Steam.

The launcher moves mod folders between active and disabled locations, updates `modinfo.json` active flags when possible, and keeps disabled local mods outside `Content/Mods` so Bellwright does not mount them accidentally. Close Bellwright before changing mod state or load order.

Native mods can declare their entry DLL in `native-runtime.json`, or place x64 DLLs in a `native` folder for automatic discovery. When several DLLs are present, the launcher parses their PE import graph and loads the root mod DLL instead of its dependencies. An ambiguous package receives a one-time DLL picker. The bundled injector receives the selected DLL's absolute path and loads it directly from the mod folder; Workshop packages cannot provide their own executable injector.

An ExcelsiorOne Ed25519 signature gives a payload the `Verified` status and cryptographically binds its hash, manifest, and supported Bellwright builds. Signatures are optional for community native mods. Unsigned or invalidly signed DLLs are not silently executed: the user can approve the exact version or trust future updates from that specific mod after a native-code warning.

Bellwright must be started while the launcher is running whenever a native mod is enabled. Launching the game directly from Steam while the launcher is not running cannot load native Workshop payloads. Launching through the launcher is the supported path.

Several approved native mods can be active at once. The launcher tracks each one by its real absolute module path instead of renaming every payload to the same staged filename.

Presets store the currently active local and Workshop mods by folder/source, load order, and compatible launcher settings. Loading a preset changes the active mod set, options, and priority order to match it, so Bellwright must be closed.

Compatible mods can ship a schema-versioned `launcher-settings.json` plus signed package or bounded `.cfg` variants inside their own folder. Variant payloads use a non-mountable `.variant` suffix until selected. The launcher validates every declared path and SHA-256 hash, stages the complete replacement set, and rolls back if a swap fails. Native DLLs read the selected config from their own mod folder; no runtime copy is created. Settings are never changed while Bellwright is running. Before launch, saved choices are reapplied when a Workshop update has restored the default package.

Conflict details are based on the asset metadata supplied by each mod's `modinfo.json`. They identify likely asset-level conflicts, but they cannot prove every possible gameplay or Blueprint logic conflict.

The update button checks the latest GitHub Release, verifies its SHA-256 digest, and applies it inside the stable launcher folder. After the new process is verified, downloaded archives, extracted files, updater scripts, logs, rollback copies, and stale folders from older updater attempts are removed. A recoverable failure restores and restarts the previous version instead of leaving partial update files behind.

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

## Linux (Steam Play / Proton)

Use the AppImage from the GitHub Releases page. Only **native Steam** (`~/.steam`, `~/.local/share/Steam`) is required; Flatpak and snap Steam installs are also detected automatically.

Bellwright must run through **Proton** (Steam Play), started from the same account the launcher runs as. The launcher locates the game the same way it does on Windows — by reading Steam's `libraryfolders.vdf` — and reads Bellwright's log and `modloadorder.json` from inside the Proton prefix (`steamapps/compatdata/1812450/pfx/drive_c/users/steamuser/...`) instead of `%LOCALAPPDATA%`.

Native (DLL) mods are loaded the same way as on Windows: the bundled injector (`CreateRemoteThread` + `LoadLibraryW`) is unchanged. On Linux the launcher runs it *through Proton*, inside Bellwright's own prefix, by reconstructing that prefix's environment from the running game process — the injector then finds Bellwright and loads the mod DLL exactly as it does under native Windows. No Wine/Proton configuration is required beyond having Bellwright already installed and launchable.

The launcher itself updates through the standard AppImage update flow (GitHub Releases) instead of the Windows PowerShell handoff.

## Build From Source (Linux)

Requirements:

- Node.js, npm
- A native Steam install (for testing against a real Bellwright/Proton prefix)

```bash
npm install
npm start
npm run package:linux
```

The packaged AppImage is written to `release/`.

The updater does not depend on Microsoft Edge. It downloads the GitHub Release directly over HTTPS and uses a GUI-safe native handoff to start hidden Windows PowerShell for ZIP extraction and in-place replacement. The handoff does not create or inherit a console window. Cleanup retries temporary Windows file locks and schedules another background pass if a lock outlives the first attempt.

See [CHANGELOG.md](CHANGELOG.md) for release details.
