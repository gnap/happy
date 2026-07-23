#!/bin/bash
set -e

# SDK 57 post-install: ensure monorepo root can resolve workspace packages.
#
# Some build tools (expo-modules-autolinking, CocoaPods config_command) run from
# the monorepo root. They need react-native at root node_modules, but Yarn
# nohoists it to the workspace level. This script creates relative symlinks so
# root-level tools find the workspace's packages.
#
# These symlinks use relative paths — the repo can be cloned/moved anywhere.

HAPPY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$HAPPY_DIR/../.." && pwd)"

# react-native is nohoisted (only in workspace node_modules)
RN_LINK="$ROOT_DIR/node_modules/react-native"
if [ ! -e "$RN_LINK" ]; then
    # Relative path from root node_modules to workspace node_modules
    ln -sf "../packages/happy-app/node_modules/react-native" "$RN_LINK"
fi

# expo is normally hoisted by yarn (not in nohoist list).
# Only create a symlink if yarn failed to hoist it.
EXPO_LINK="$ROOT_DIR/node_modules/expo"
EXPO_TARGET="$HAPPY_DIR/node_modules/expo"
if [ ! -e "$EXPO_LINK" ] && [ -d "$EXPO_TARGET" ]; then
    ln -sf "../packages/happy-app/node_modules/expo" "$EXPO_LINK"
fi

echo "SDK57 post-install: done"
