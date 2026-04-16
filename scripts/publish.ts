#!/usr/bin/env bun
/**
 * Build and publish lilac as platform-specific npm packages.
 *
 * Package structure (follows esbuild/swc pattern):
 *
 *   @anthropic/lilac            — wrapper with optional-deps, JS shim picks correct platform
 *   @anthropic/lilac-darwin-arm64   — macOS ARM binary
 *   @anthropic/lilac-darwin-x64     — macOS Intel binary
 *   @anthropic/lilac-linux-x64      — Linux x64 binary
 *   @anthropic/lilac-linux-arm64    — Linux ARM binary
 *
 * Usage:
 *   bun scripts/publish.ts build              — build binaries for all platforms
 *   bun scripts/publish.ts build --local      — build only for current platform
 *   bun scripts/publish.ts pack               — create .tgz files for testing
 *   bun scripts/publish.ts publish [--tag]     — publish to npm registry
 *
 * Environment:
 *   LILAC_NPM_SCOPE    — npm scope (default: @anthropic)
 *   LILAC_REGISTRY     — npm registry URL (default: https://registry.npmjs.org)
 *
 * Note: Cross-compilation requires `bun build --compile --target` support.
 * For now, build on each target platform or use CI matrix builds.
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "npm-dist");
const PKG = JSON.parse(await Bun.file(join(ROOT, "package.json")).text());
const VERSION = PKG.version;

const SCOPE = process.env.LILAC_NPM_SCOPE ?? "@tarka";

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

  // Clean and create
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });

  const isCurrent =
    platform.os === process.platform && platform.arch === process.arch;

  if (isCurrent) {
    // Export invite codes before build
    try {
      execSync("bun scripts/invite.ts export", { cwd: ROOT, stdio: "pipe" });
    } catch {
      // No invite codes = open access dev build
    }

    // Build for current platform
    execSync(
      `bun build --compile --minify src/index.ts --outfile ${join(dir, "bin", "lilac")} --external chromium-bidi --external electron`,
      { cwd: ROOT, stdio: "inherit" }
    );
  } else {
    // Cross-compile using bun's --target flag
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

  // Write package.json for the platform package
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
        publishConfig: { access: "restricted" },
      },
      null,
      2
    ) + "\n"
  );

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

  // Write package.json
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
        publishConfig: { access: "restricted" },
        license: "SEE LICENSE IN LICENSE",
        homepage: "https://lilac.tarka.ai",
        repository: {
          type: "git",
          url: "https://github.com/tarkaai/lilac-cli.git",
        },
      },
      null,
      2
    ) + "\n"
  );

  // Write the JS shim that finds the right platform binary
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(
    join(dir, "bin", "lilac"),
    `#!/usr/bin/env node
"use strict";

const { platform, arch } = process;
const path = require("path");
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

  // Copy LICENSE
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
    // Create .tgz files for local testing
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
      // Publish platform packages first, then wrapper
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
        execSync(`npm publish --tag ${tag}`, { cwd: dir, stdio: "inherit" });
        console.log(`✓ Published ${pkg}`);
      } catch {
        console.error(`✗ Failed to publish ${pkg}`);
      }
    }
    break;
  }

  default:
    console.log(`lilac npm publish tool

Usage:
  bun scripts/publish.ts build [--local]     — build platform binary packages
  bun scripts/publish.ts pack                — create .tgz files for testing
  bun scripts/publish.ts publish [--tag=TAG] — publish to npm registry

Environment:
  LILAC_NPM_SCOPE   — npm scope (default: @tarka)
`);
}
