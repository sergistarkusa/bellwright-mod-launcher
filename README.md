# Bellwright Mod Launcher

Small Windows launcher for managing Bellwright local and Steam Workshop mods.

It shows installed mods in two compact columns:

- **Available**: installed but disabled mods
- **Active**: mods currently loaded by Bellwright

Drag a mod between columns or use the row action button to enable/disable it. The launcher detects Bellwright's Steam library, local `Content/Mods`, and Workshop folder for app id `1812450`.

## Features

- Manage local Bellwright mods and subscribed Steam Workshop mods.
- Keep disabled Workshop mods in a reversible launcher-managed folder.
- Prevent mod changes while Bellwright is running.
- Open the Bellwright mods folder.
- Launch Bellwright through Steam.
- Join the Bellwright Discord section from the app.
- Support FSD Software through Ko-fi.

## Download

Use the latest Windows portable ZIP from the GitHub Releases page.

Unzip it anywhere and run `BellwrightModLauncher.exe`.

## Notes

This is an unofficial community tool and is not affiliated with Donkey Crew, Snail Games, or Steam.

The launcher moves mod folders between active and disabled locations. Close Bellwright before changing mod state.

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

