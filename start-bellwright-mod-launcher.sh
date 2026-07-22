#!/bin/sh
# Convenience launcher for running from source on Linux (mirrors
# "Start Bellwright Mod Launcher.cmd" on Windows). Packaged AppImage/deb
# builds do not need this; they are already a standalone executable.
cd "$(dirname "$0")" || exit 1
if [ -x "node_modules/.bin/electron" ]; then
  exec node_modules/.bin/electron .
else
  exec npm start
fi
