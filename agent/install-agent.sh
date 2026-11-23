#!/bin/sh
# DevDock agent installer. DevDock's install command downloads this file, checks it against
# the sha256 DevDock ships with, and hands over the pairing token on stdin (never in argv,
# where any local user could read it from /proc). This script then trusts only binaries whose
# SHA256SUMS carries a signature from DevDock's release key below: a tampered GitHub
# release, or anyone between here and GitHub, gets a refusal.
set -eu

RELEASE_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPDrBd+WV7Nk4MKmf2GK1fqj/SLCYEK0zlHOg48MKUgb"
BASE="${DEVDOCK_AGENT_URL:-https://github.com/Osama-Yusuf/devdock/releases/latest/download}"

main() {
  [ "$(id -u)" = 0 ] || { echo "Run it with sudo" >&2; exit 1; }
  command -v ssh-keygen >/dev/null 2>&1 || { echo "Needs ssh-keygen to check the signature: install openssh-client (or openssh-keygen)" >&2; exit 1; }

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "Unsupported system: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac

  # the token arrives on stdin; it reaches the agent through the environment, which only root can read
  IFS= read -r DEVDOCK_TOKEN || true
  export DEVDOCK_TOKEN

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  name="devdock-agent-$os-$arch"
  echo "Downloading $name…"
  get "$BASE/$name" "$tmp/devdock-agent"
  get "$BASE/SHA256SUMS" "$tmp/SHA256SUMS"
  get "$BASE/SHA256SUMS.sig" "$tmp/SHA256SUMS.sig"

  echo "devdock-release namespaces=\"devdock-release\" $RELEASE_KEY" > "$tmp/allowed"
  ssh-keygen -Y verify -f "$tmp/allowed" -I devdock-release -n devdock-release -s "$tmp/SHA256SUMS.sig" < "$tmp/SHA256SUMS" >/dev/null 2>&1 \
    || { echo "SHA256SUMS isn't signed by DevDock's release key: not installing." >&2; exit 1; }

  want=$(grep " $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/devdock-agent" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$tmp/devdock-agent" | cut -d' ' -f1); fi
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "Checksum mismatch: not installing." >&2; exit 1; }

  chmod +x "$tmp/devdock-agent"
  "$tmp/devdock-agent" install "$@"
}

get() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"; fi
}

main "$@" # only runs once the whole file has arrived
