#!/usr/bin/env bash
# Install the latest allman CLI binary from GitHub Releases.
#
# Defaults to a user-writable prefix ($HOME/.local) so the install never
# needs sudo, matching how rustup, bun, deno, uv, etc. ship. Override with
# PREFIX=/usr/local (and accept the sudo prompt) for a system-wide install.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tarkaai/allman-cli/main/install.sh | bash
#   curl -fsSL .../install.sh | VERSION=2026-04-20.1-alpha bash
#   curl -fsSL .../install.sh | PREFIX=/usr/local bash        # system-wide
#
# While the repo is still private, pass a GitHub token so curl can
# auth against release assets and raw.githubusercontent.com:
#   GH_TOKEN=$(gh auth token) bash -c 'curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
#     https://raw.githubusercontent.com/tarkaai/allman-cli/main/install.sh | bash'
set -euo pipefail

REPO="tarkaai/allman-cli"
VERSION="${VERSION:-latest}"
PREFIX="${PREFIX:-$HOME/.local}"
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

# Fetch release metadata via the REST API.
# - Uses /releases?per_page=1 for "latest" so we include prereleases (unlike
#   /releases/latest/download/ which skips them).
# - Downloads assets via /releases/assets/{id} with Accept: application/octet-stream;
#   that endpoint works on both public and private repos and survives the
#   redirect to objects.githubusercontent.com (signed URL; no auth-header
#   stripping issues).
if ! command -v python3 >/dev/null 2>&1; then
  echo "install.sh needs python3 to parse release metadata" >&2
  exit 1
fi

if [ "$VERSION" = "latest" ]; then
  release_url="https://api.github.com/repos/$REPO/releases?per_page=1"
  release_json="$(curl -fsSL "${auth_args[@]}" "$release_url")"
  release_json="$(echo "$release_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d[0]) if d else "")')"
  if [ -z "$release_json" ]; then
    echo "could not resolve latest release for $REPO" >&2
    exit 1
  fi
  VERSION="$(echo "$release_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tag_name"])')"
  echo "resolved latest release: $VERSION"
else
  release_json="$(curl -fsSL "${auth_args[@]}" "https://api.github.com/repos/$REPO/releases/tags/$VERSION")"
fi

resolve_asset_id() {
  echo "$release_json" | python3 -c 'import json,sys
data = json.load(sys.stdin)
name = sys.argv[1]
for a in data.get("assets", []):
    if a["name"] == name:
        print(a["id"])
        sys.exit(0)
sys.exit(1)' "$1"
}

bin_id="$(resolve_asset_id "$asset")" || { echo "asset $asset not found in release $VERSION" >&2; exit 1; }
sha_id="$(resolve_asset_id "$asset.sha256" || true)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading $asset from $VERSION..."
curl -fsSL "${auth_args[@]}" -H "Accept: application/octet-stream" \
  -o "$tmp/allman" \
  "https://api.github.com/repos/$REPO/releases/assets/$bin_id"
if [ -n "$sha_id" ]; then
  curl -fsSL "${auth_args[@]}" -H "Accept: application/octet-stream" \
    -o "$tmp/allman.sha256" \
    "https://api.github.com/repos/$REPO/releases/assets/$sha_id"
fi

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

mkdir -p "$BIN_DIR" 2>/dev/null || true
if [ -w "$BIN_DIR" ]; then
  mv "$tmp/allman" "$BIN_DIR/allman"
else
  echo "installing to $BIN_DIR requires sudo..."
  sudo mkdir -p "$BIN_DIR"
  sudo mv "$tmp/allman" "$BIN_DIR/allman"
fi

echo "installed: $BIN_DIR/allman"
if ! command -v allman >/dev/null 2>&1; then
  cat >&2 <<EOF
note: $BIN_DIR is not on your PATH yet.
  bash/zsh:
    echo 'export PATH="$BIN_DIR:\$PATH"' >> ~/.zshrc
    exec zsh
  fish:
    fish_add_path "$BIN_DIR"
EOF
fi
