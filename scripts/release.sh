#!/bin/sh
# Builds DevDock v<package.json version> for Apple silicon into dist/app:
#   DevDock-<v>-arm64.dmg          what people download
#   DevDock-<v>-arm64.app.tar.gz   what the in-app updater downloads, and its .sig
#   latest.json                    what the updater checks: releases/latest/download/latest.json
# Upload everything in dist/app (and dist/agent, see agent/release.sh) to the GitHub release v<v>.
#
# Needs the updater key (~/.config/devdock/updater.key, or $TAURI_SIGNING_PRIVATE_KEY): without
# it no installed DevDock would accept the update. Keep it off GitHub and backed up.
# Optional: DEVDOCK_SIGN_IDENTITY="Developer ID Application: ..." signs the app, and a
# notarytool keychain profile named "devdock" notarizes and staples the dmg.
set -eu
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
OUT=dist/app
T=src-tauri/target/release/bundle

KEY=${TAURI_SIGNING_PRIVATE_KEY:-$(cat "$HOME/.config/devdock/updater.key")}
export TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
[ -n "${DEVDOCK_SIGN_IDENTITY:-}" ] && export APPLE_SIGNING_IDENTITY="$DEVDOCK_SIGN_IDENTITY"

npm run -s build:prep
[ "$(uname -m)" = arm64 ] || { echo "Build on Apple silicon: the release is arm64"; exit 1; }
(cd src-tauri && cargo tauri build --bundles app,dmg)

rm -rf "$OUT"; mkdir -p "$OUT"
cp "$T/dmg/DevDock_${V}_aarch64.dmg" "$OUT/DevDock-$V-arm64.dmg"
cp "$T/macos/DevDock.app.tar.gz" "$OUT/DevDock-$V-arm64.app.tar.gz"
cp "$T/macos/DevDock.app.tar.gz.sig" "$OUT/DevDock-$V-arm64.app.tar.gz.sig"

if [ -n "${DEVDOCK_SIGN_IDENTITY:-}" ]; then
  xcrun notarytool submit "$OUT/DevDock-$V-arm64.dmg" --keychain-profile devdock --wait
  xcrun stapler staple "$OUT/DevDock-$V-arm64.dmg"
fi

# notes: the release's text, filled in on GitHub; the app shows a link to it
node -e '
const fs = require("fs"), [V, out] = process.argv.slice(1);
const name = `DevDock-${V}-arm64.app.tar.gz`;
fs.writeFileSync(`${out}/latest.json`, JSON.stringify({
  version: V, pub_date: new Date().toISOString(), notes: "",
  platforms: { "darwin-aarch64": {
    signature: fs.readFileSync(`${out}/${name}.sig`, "utf8").trim(),
    url: `https://github.com/Osama-Yusuf/devdock/releases/download/v${V}/${name}`,
  } },
}, null, 2));
' "$V" "$OUT"
ls -lh "$OUT"
echo "v$V ready in $OUT"
