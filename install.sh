#!/usr/bin/env bash
# Install the latest allman CLI binary from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tarkaai/allman-cli/main/install.sh | bash
#   curl -fsSL .../install.sh | VERSION=2026-04-20.1-alpha bash
#   curl -fsSL .../install.sh | PREFIX=$HOME/.local bash
#
# While the repo is still private, pass a GitHub token so curl can
# auth against release assets and raw.githubusercontent.com:
#   GH_TOKEN=$(gh auth token) bash -c 'curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
#     https://raw.githubusercontent.com/tarkaai/allman-cli/main/install.sh | bash'
set -euo pipefail

REPO="tarkaai/allman-cli"
VERSION="${VERSION:-latest}"
PREFIX="${PREFIX:-/usr/local}"
BIN_DIR="$PREFIX/bin"

# Optional bearer auth — needed while the repo is private; harmless once public.
auth_args=()
if [ -n "${GH_TOKEN:-}" ]; then
  auth_args=(-H "Authorization: Bearer $GH_TOKEN")
fi

case "$(uname -s)" in
  Linux)  os="linux"  ;;
  Darwin) os="darwin" ;;
  *) echo "unsupported OS: $(uname -s) (allman ships linux + darwin)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

asset="allman-$os-$arch"

# /releases/latest/download/ skips prereleases. Resolve via the REST API
# instead so "latest" during alpha/beta picks up the current alpha/beta.
if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "${auth_args[@]}" \
    "https://api.github.com/repos/$REPO/releases?per_page=1" \
    | awk -F'"' '/"tag_name":/ {print $4; exit}')"
  if [ -z "$VERSION" ]; then
    echo "could not resolve latest release for $REPO" >&2
    exit 1
  fi
  echo "resolved latest release: $VERSION"
fi
url="https://github.com/$REPO/releases/download/$VERSION/$asset"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading $asset from $VERSION..."
curl -fsSL "${auth_args[@]}" -o "$tmp/allman" "$url"
curl -fsSL "${auth_args[@]}" -o "$tmp/allman.sha256" "$url.sha256" || true

if [ -s "$tmp/allman.sha256" ]; then
  expected="$(awk '{print $1}' "$tmp/allman.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/allman" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$tmp/allman" | awk '{print $1}')"
  fi
  if [ "$expected" = "$actual" ]; then
    echo "checksum ok"
  else
    echo "checksum mismatch: expected $expected got $actual" >&2
    exit 1
  fi
fi

chmod +x "$tmp/allman"

if [ -w "$BIN_DIR" ] 2>/dev/null || { [ ! -e "$BIN_DIR" ] && mkdir -p "$BIN_DIR" 2>/dev/null; }; then
  mv "$tmp/allman" "$BIN_DIR/allman"
else
  echo "installing to $BIN_DIR requires sudo..."
  sudo mkdir -p "$BIN_DIR"
  sudo mv "$tmp/allman" "$BIN_DIR/allman"
fi

echo "installed: $BIN_DIR/allman"
command -v allman >/dev/null || echo "note: $BIN_DIR is not on PATH — add it to your shell profile."
