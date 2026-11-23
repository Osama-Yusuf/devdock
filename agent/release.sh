#!/bin/sh
# Builds and signs the agent's release assets into dist/agent, for the GitHub release v<package.json version>:
#   devdock-agent-<os>-<arch>   SHA256SUMS(.sig)   agent-manifest.json(.sig)   install-agent.sh
# Needs Go and the release key (see release-sign.js). Upload everything in dist/agent to the release.
set -eu
cd "$(dirname "$0")"
V=$(node -p "require('../package.json').version")
KEY=$(node release-sign.js pub | sed -n 's/^-X main.updateKey=//p')
OUT=../dist/agent
rm -rf "$OUT"; mkdir -p "$OUT"
for t in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
  GOOS=${t%-*} GOARCH=${t#*-} CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$V -X main.updateKey=$KEY" -o "$OUT/devdock-agent-$t" .
done
cp install-agent.sh "$OUT/"
cd "$OUT"
shasum -a 256 devdock-agent-* > SHA256SUMS
node ../../agent/release-sign.js sign SHA256SUMS
# self-update manifest; expires so an old signed manifest can't be replayed forever
node -e '
const fs = require("fs"), V = process.argv[1], assets = {};
for (const l of fs.readFileSync("SHA256SUMS", "utf8").trim().split("\n")) {
  const [sha, name] = l.split(/\s+/);
  assets[name.replace("devdock-agent-", "")] = { url: `https://github.com/Osama-Yusuf/devdock/releases/download/v${V}/${name}`, sha256: sha };
}
fs.writeFileSync("agent-manifest.json", JSON.stringify({ version: V, expires: new Date(Date.now() + 180 * 864e5).toISOString(), assets }, null, 2));
' "$V"
node ../../agent/release-sign.js raw agent-manifest.json
echo "v$V assets ready in dist/agent"
