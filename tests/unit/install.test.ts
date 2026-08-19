/**
 * install.sh runs under macOS's Bash 3.2, where `set -u` plus an empty-array
 * expansion aborts with "unbound variable". That is exactly what the optional
 * auth-header array used to do, so the documented unauthenticated install —
 * `curl -fsSL .../install.sh | bash` — failed on every stock macOS before
 * fetching anything. These tests drive the real script against a fake `curl`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const installer = resolve(import.meta.dirname, "../../install.sh");
const runsHere = process.platform === "darwin" || process.platform === "linux";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function runInstaller(ghToken?: string) {
  tempDir = mkdtempSync(join(tmpdir(), "allman-install-"));
  const fakeBin = join(tempDir, "fake-bin");
  // PREFIX is what keeps this hermetic; HOME is deliberately left alone. The
  // installer only reads it to default PREFIX, and overriding it breaks the
  // `python3` it shells out to wherever python3 is a version-manager shim
  // (asdf, mise, pyenv) that resolves its interpreter through $HOME.
  const prefix = join(tempDir, "prefix");
  mkdirSync(fakeBin, { recursive: true });

  const os = process.platform === "darwin" ? "darwin" : "linux";
  const asset = `allman-${os}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  writeFileSync(
    join(fakeBin, "curl"),
    `#!/bin/sh
out=""; url=""; auth=""; accept=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H)
      case "$2" in
        Authorization:*) auth="$2" ;;
        Accept:*) accept="$2" ;;
      esac
      shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ "$REQUIRE_AUTH" = "1" ] && [ "$auth" != "Authorization: Bearer test-token" ]; then
  echo "expected bearer auth, got: '$auth'" >&2; exit 42
fi
if [ "$REQUIRE_AUTH" = "0" ] && [ -n "$auth" ]; then
  echo "sent auth without a token: '$auth'" >&2; exit 46
fi
case "$url" in
  'https://api.github.com/repos/tarkaai/allman-cli/releases?per_page=1')
    [ -z "$out" ] || exit 43
    printf '%s\\n' '[{"tag_name":"test-release","assets":[{"name":"${asset}","id":1}]}]' ;;
  'https://api.github.com/repos/tarkaai/allman-cli/releases/assets/1')
    [ "$accept" = "Accept: application/octet-stream" ] || exit 44
    printf '%s\\n' '#!/bin/sh' 'echo allman test binary' > "$out" ;;
  *) echo "unexpected URL: $url" >&2; exit 45 ;;
esac
`
  );
  chmodSync(join(fakeBin, "curl"), 0o755);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${fakeBin}:${process.env.PATH}`,
    PREFIX: prefix,
    VERSION: "latest",
    REQUIRE_AUTH: ghToken ? "1" : "0",
  };
  if (ghToken) env.GH_TOKEN = ghToken;
  else delete env.GH_TOKEN;

  return {
    binary: join(prefix, "bin", "allman"),
    // /bin/bash is 3.2 on macOS — the shell this regression is about.
    result: spawnSync("/bin/bash", [installer], { env, encoding: "utf8" }),
  };
}

describe.runIf(runsHere)("install.sh", () => {
  test("installs without a GitHub token", () => {
    const { binary, result } = runInstaller();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(binary)).toBe(true);
  });

  test("authenticates metadata and asset requests when GH_TOKEN is set", () => {
    const { binary, result } = runInstaller("test-token");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(binary)).toBe(true);
  });
});
