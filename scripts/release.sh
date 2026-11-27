#!/bin/sh
# Builds DevDock v<package.json version> for Apple silicon into dist/app:
#   DevDock-<v>-arm64.dmg          what people download
#   DevDock-<v>-arm64.app.tar.gz   what the in-app updater downloads, and its .sig
#   latest.json                    what the updater checks: releases/latest/download/latest.json
# Upload everything in dist/app (and dist/agent, see agent/release.sh) to the GitHub release v<v>.
#
# Needs the updater key (~/.config/devdock/updater.key, or $TAURI_SIGNING_PRIVATE_KEY): without
# it no installed DevDock would accept the update. Keep it off GitHub and backed up.
# Signing: DEVDOCK_SIGN_IDENTITY, else this Mac's "Developer ID Application" certificate, else the
# self-made "DevDock Local Signing" one (back it up: Keychain Access, export as .p12; losing it resets
# every user's permissions). A stable identity keeps Automation and the login item across updates;
# ad-hoc signing ties them to one build. Local Network may still ask again after an update: macOS
# tracks that one per build (unverified). DEVDOCK_ADHOC=1 builds unsigned on purpose. With a Developer ID,
# set APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH (or APPLE_ID, APPLE_PASSWORD and
# APPLE_TEAM_ID): Tauri notarizes and staples the app, so the updater's copy is stapled too, and
# this script does the same for the dmg.
set -eu
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
OUT=dist/app
T=src-tauri/target/release/bundle

KEY=${TAURI_SIGNING_PRIVATE_KEY:-$(cat "$HOME/.config/devdock/updater.key")}
export TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
ID=${DEVDOCK_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}
if [ -z "$ID" ] && security find-identity -p codesigning | grep -q '"DevDock Local Signing"'; then ID="DevDock Local Signing"; fi
[ -n "$ID" ] || [ "${DEVDOCK_ADHOC:-}" = 1 ] || { echo "No signing identity: users would lose DevDock's permissions on this update. Unlock the keychain, or set DEVDOCK_ADHOC=1"; exit 1; }
# a Developer ID (by name or hash) must be notarized, so check the credentials before a long build
DEVID=; [ -n "$ID" ] && security find-identity -v -p codesigning | grep -F "$ID" | grep -q '"Developer ID Application' && DEVID=1
if [ -n "$DEVID" ] && ! { [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; } \
   && ! { [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; }; then
  echo "Developer ID found but no notarization credentials: set APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH"; exit 1
fi

npm run -s build:prep
if [ -n "$ID" ]; then
  export APPLE_SIGNING_IDENTITY="$ID"
  # Tauri signs the app and its main binary but not this helper in Resources; notarization needs it signed too
  if [ -n "$DEVID" ]; then TS=--timestamp; else TS=--timestamp=none; fi # Apple timestamps only its own certificates
  codesign --force --options runtime "$TS" -s "$ID" native/devdock-key
fi
[ "$(uname -m)" = arm64 ] || { echo "Build on Apple silicon: the release is arm64"; exit 1; }
(cd src-tauri && cargo tauri build --bundles app,dmg)

rm -rf "$OUT"; mkdir -p "$OUT"
cp "$T/dmg/DevDock_${V}_aarch64.dmg" "$OUT/DevDock-$V-arm64.dmg"
cp "$T/macos/DevDock.app.tar.gz" "$OUT/DevDock-$V-arm64.app.tar.gz"
cp "$T/macos/DevDock.app.tar.gz.sig" "$OUT/DevDock-$V-arm64.app.tar.gz.sig"

if [ -n "$DEVID" ]; then
  if [ -n "${APPLE_API_KEY:-}" ]; then set -- --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
  else set -- --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"; fi
  xcrun notarytool submit "$OUT/DevDock-$V-arm64.dmg" "$@" --wait
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
