#!/usr/bin/env bash
# Install the latest allman CLI binary from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tarkaai/allman-cli/main/install.sh | bash
#   curl -fsSL .../install.sh | VERSION=2026-04-20.1-alpha bash
#   curl -fsSL .../install.sh | PREFIX=$HOME/.local bash
set -euo pipefail

REPO="tarkaai/allman-cli"
VERSION="${VERSION:-latest}"
PREFIX="${PREFIX:-/usr/local}"
BIN_DIR="$PREFIX/bin"

os="$(uname -s)"
if [ "$os" != "Linux" ]; then
  echo "allman releases are Linux-only (detected: $os)" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

asset="allman-linux-$arch"
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading $asset from $VERSION…"
curl -fsSL -o "$tmp/allman" "$url"
curl -fsSL -o "$tmp/allman.sha256" "$url.sha256" || true

if [ -s "$tmp/allman.sha256" ]; then
  (cd "$tmp" && sha256sum -c allman.sha256 >/dev/null) && echo "checksum ok"
fi

chmod +x "$tmp/allman"

if [ -w "$BIN_DIR" ] 2>/dev/null || { [ ! -e "$BIN_DIR" ] && mkdir -p "$BIN_DIR" 2>/dev/null; }; then
  mv "$tmp/allman" "$BIN_DIR/allman"
else
  echo "installing to $BIN_DIR requires sudo…"
  sudo mkdir -p "$BIN_DIR"
  sudo mv "$tmp/allman" "$BIN_DIR/allman"
fi

echo "installed: $BIN_DIR/allman"
command -v allman >/dev/null || echo "note: $BIN_DIR is not on PATH — add it to your shell profile."
