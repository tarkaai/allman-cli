#!/usr/bin/env bun
/**
 * Build and publish lilac as platform-specific npm packages via GitHub Packages.
 *
 * Package structure (follows esbuild/swc pattern):
 *
 *   @tarkaai/lilac                  — wrapper with optional-deps, JS shim picks correct platform
 *   @tarkaai/lilac-darwin-arm64     — macOS ARM binary
 *   @tarkaai/lilac-darwin-x64       — macOS Intel binary
 *   @tarkaai/lilac-linux-x64        — Linux x64 binary
 *   @tarkaai/lilac-linux-arm64      — Linux ARM binary
 *
 * Published to GitHub Packages (npm.pkg.github.com). Access is controlled by
 * GitHub org membership — anyone with read access to the repo can install.
 *
 * Usage:
 *   bun scripts/publish.ts build              — build binaries for all platforms
 *   bun scripts/publish.ts build --local      — build only for current platform
 *   bun scripts/publish.ts pack               — create .tgz files for testing
 *   bun scripts/publish.ts publish [--tag]     — publish to GitHub Packages
 *
 * Prerequisites:
 *   1. Authenticate to GitHub Packages:
 *      echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT" >> ~/.npmrc
 *   2. PAT needs `packages:write` scope (for publishing) or `packages:read` (for installing)
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "npm-dist");
const PKG = JSON.parse(await Bun.file(join(ROOT, "package.json")).text());
const VERSION = PKG.version;

const SCOPE = "@tarkaai";
const REGISTRY = "https://npm.pkg.github.com";

interface Platform {
  os: string;
  arch: string;
  bunTarget: string;
}

const PLATFORMS: Platform[] = [
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
];

function platformPkgName(p: Platform): string {
  return `${SCOPE}/lilac-${p.os}-${p.arch}`;
}

function currentPlatform(): Platform | undefined {
  return PLATFORMS.find(
    (p) => p.os === process.platform && p.arch === process.arch
  );
}

/**
 * Build a platform-specific binary package.
 */
function buildPlatformPackage(platform: Platform): void {
  const pkgName = platformPkgName(platform);
  const dir = join(DIST, `lilac-${platform.os}-${platform.arch}`);

  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });

  const isCurrent =
    platform.os === process.platform && platform.arch === process.arch;

  if (isCurrent) {
    execSync(
      `bun build --compile --minify src/index.ts --outfile ${join(dir, "bin", "lilac")} --external chromium-bidi --external electron`,
      { cwd: ROOT, stdio: "inherit" }
    );
  } else {
    try {
      execSync(
        `bun build --compile --minify --target=${platform.bunTarget} src/index.ts --outfile ${join(dir, "bin", "lilac")} --external chromium-bidi --external electron`,
        { cwd: ROOT, stdio: "inherit" }
      );
    } catch {
      console.warn(
        `⚠ Cross-compile for ${platform.os}-${platform.arch} failed. Build on target platform or use CI.`
      );
      return;
    }
  }

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: pkgName,
        version: VERSION,
        description: `lilac CLI binary for ${platform.os}-${platform.arch}`,
        os: [platform.os],
        cpu: [platform.arch],
        bin: { lilac: "bin/lilac" },
        files: ["bin/lilac"],
        repository: {
          type: "git",
          url: "https://github.com/tarkaai/lilac-cli.git",
        },
        publishConfig: {
          registry: REGISTRY,
        },
      },
      null,
      2
    ) + "\n"
  );

  // Write .npmrc so publish targets GitHub Packages
  writeFileSync(join(dir, ".npmrc"), `${SCOPE}:registry=${REGISTRY}\n`);

  console.log(`✓ Built ${pkgName}@${VERSION}`);
}

/**
 * Build the wrapper package that uses optionalDependencies to pull
 * the correct platform binary.
 */
function buildWrapperPackage(): void {
  const dir = join(DIST, "lilac");

  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });

  const optionalDependencies: Record<string, string> = {};
  for (const p of PLATFORMS) {
    optionalDependencies[platformPkgName(p)] = VERSION;
  }

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `${SCOPE}/lilac`,
        version: VERSION,
        description:
          "lilac — LinkedIn API Command Suite. CLI for syncing, searching, and messaging on LinkedIn.",
        bin: { lilac: "bin/lilac" },
        files: ["bin/lilac"],
        optionalDependencies,
        license: "SEE LICENSE IN LICENSE",
        homepage: "https://lilac.tarka.ai",
        repository: {
          type: "git",
          url: "https://github.com/tarkaai/lilac-cli.git",
        },
        publishConfig: {
          registry: REGISTRY,
        },
      },
      null,
      2
    ) + "\n"
  );

  // Write .npmrc so publish targets GitHub Packages
  writeFileSync(join(dir, ".npmrc"), `${SCOPE}:registry=${REGISTRY}\n`);

  // Write the JS shim that finds the right platform binary
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(
    join(dir, "bin", "lilac"),
    `#!/usr/bin/env node
"use strict";

const { platform, arch } = process;
const { execFileSync } = require("child_process");

const pkg = \`${SCOPE}/lilac-\${platform}-\${arch}\`;
let binPath;

try {
  binPath = require.resolve(\`\${pkg}/bin/lilac\`);
} catch {
  console.error(
    \`lilac does not have a prebuilt binary for \${platform}-\${arch}.\\n\` +
    \`Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64\\n\` +
    \`Try building from source: https://github.com/tarkaai/lilac-cli\`
  );
  process.exit(1);
}

try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (err) {
  if (err && typeof err === "object" && "status" in err) {
    process.exit(err.status);
  }
  throw err;
}
`
  );

  if (existsSync(join(ROOT, "LICENSE"))) {
    copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  }

  console.log(`✓ Built ${SCOPE}/lilac@${VERSION} (wrapper)`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

switch (command) {
  case "build": {
    if (existsSync(DIST)) rmSync(DIST, { recursive: true });
    mkdirSync(DIST, { recursive: true });

    if (args.includes("--local")) {
      const current = currentPlatform();
      if (!current) {
        console.error(`Unsupported platform: ${process.platform}-${process.arch}`);
        process.exit(1);
      }
      buildPlatformPackage(current);
    } else {
      for (const p of PLATFORMS) {
        buildPlatformPackage(p);
      }
    }

    buildWrapperPackage();
    console.log(`\nAll packages in: ${DIST}/`);
    break;
  }

  case "pack": {
    const packages = [
      "lilac",
      ...PLATFORMS.map((p) => `lilac-${p.os}-${p.arch}`),
    ];
    for (const pkg of packages) {
      const dir = join(DIST, pkg);
      if (!existsSync(dir)) continue;
      try {
        execSync("npm pack", { cwd: dir, stdio: "inherit" });
        console.log(`✓ Packed ${pkg}`);
      } catch {
        console.warn(`⚠ Failed to pack ${pkg}`);
      }
    }
    break;
  }

  case "publish": {
    const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "latest";
    const packages = [
      ...PLATFORMS.map((p) => `lilac-${p.os}-${p.arch}`),
      "lilac",
    ];
    for (const pkg of packages) {
      const dir = join(DIST, pkg);
      if (!existsSync(dir)) {
        console.warn(`⚠ Skipping ${pkg} (not built)`);
        continue;
      }
      try {
        execSync(`npm publish --registry ${REGISTRY} --tag ${tag}`, {
          cwd: dir,
          stdio: "inherit",
        });
        console.log(`✓ Published ${pkg}`);
      } catch {
        console.error(`✗ Failed to publish ${pkg}`);
      }
    }
    break;
  }

  default:
    console.log(`lilac GitHub Packages publish tool

Usage:
  bun scripts/publish.ts build [--local]     — build platform binary packages
  bun scripts/publish.ts pack                — create .tgz files for testing
  bun scripts/publish.ts publish [--tag=TAG] — publish to GitHub Packages

Setup (one-time):
  1. Create a GitHub PAT with packages:write scope
  2. echo "//npm.pkg.github.com/:_authToken=YOUR_PAT" >> ~/.npmrc

For beta users (install only):
  1. Create a GitHub PAT with packages:read scope
  2. echo "//npm.pkg.github.com/:_authToken=YOUR_PAT" >> ~/.npmrc
  3. echo "@tarkaai:registry=https://npm.pkg.github.com" >> ~/.npmrc
  4. npx @tarkaai/lilac login
`);
}
