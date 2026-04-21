#!/usr/bin/env bun
// Cut a local allman-cli release: lint → test → build both Linux arches →
// checksum → tag → push → `gh release create` with assets.
//
// Usage:
//   bun run release 2026-04-20.1-alpha
//   bun run release 2026-04-20.1-alpha --skip-tests   # not recommended
//   bun run release 2026-04-20.1-alpha --dry-run      # build but don't tag/publish
//
// Any tag containing `-alpha` or `-beta` is published as a GitHub prerelease.

import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const REPO = "tarkaai/allman-cli";
const BIN = "allman";
const TAG_REGEX = /^20\d{2}-\d{2}-\d{2}\.\d+(?:-(?:alpha|beta))?$/;
const TARGETS = [
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
] as const;

function die(msg: string): never {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function log(msg: string) {
  console.log(`release: ${msg}`);
}

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith("--"));
const skipTests = args.includes("--skip-tests");
const dryRun = args.includes("--dry-run");

if (!tag) die("usage: bun run release <tag> [--skip-tests] [--dry-run]");
if (!TAG_REGEX.test(tag))
  die(`tag ${tag} does not match YYYY-MM-DD.N[-alpha|-beta]`);

const isPrerelease = tag.includes("-alpha") || tag.includes("-beta");

async function sh(cmd: string): Promise<string> {
  const out = await $`sh -c ${cmd}`.quiet();
  return out.stdout.toString().trim();
}

async function assertCleanTree() {
  const status = await sh("git status --porcelain");
  if (status) die(`working tree not clean:\n${status}`);
}

async function assertOnMainPushed() {
  const branch = await sh("git rev-parse --abbrev-ref HEAD");
  if (branch !== "main") die(`not on main (on ${branch})`);
  await sh("git fetch origin main --quiet");
  const local = await sh("git rev-parse HEAD");
  const remote = await sh("git rev-parse origin/main");
  if (local !== remote) die("local main is not in sync with origin/main");
}

async function assertTagAvailable() {
  const existing = await sh(`git tag -l ${tag}`);
  if (existing) die(`tag ${tag} already exists locally`);
  const remote = await sh(
    `git ls-remote --tags origin refs/tags/${tag} | head -1`
  );
  if (remote) die(`tag ${tag} already exists on origin`);
}

async function build(os: string, arch: string, bunTarget: string) {
  const outfile = join(DIST, `${BIN}-${os}-${arch}`);
  log(`building ${outfile}`);
  await $`bun build --compile --minify --target=${bunTarget} src/index.ts --outfile ${outfile} --external chromium-bidi --external electron`;
  return outfile;
}

function sha256(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function main() {
  log(`cutting ${tag} (${isPrerelease ? "prerelease" : "stable"})`);
  await assertCleanTree();
  await assertOnMainPushed();
  await assertTagAvailable();

  log("lint");
  await $`bun run lint`;

  if (!skipTests) {
    log("test");
    await $`bun test`;
  } else {
    log("skipping tests (--skip-tests)");
  }

  mkdirSync(DIST, { recursive: true });
  const assets: string[] = [];
  for (const { os, arch, bunTarget } of TARGETS) {
    const bin = await build(os, arch, bunTarget);
    const sumPath = `${bin}.sha256`;
    const sum = sha256(bin);
    writeFileSync(sumPath, `${sum}  ${BIN}-${os}-${arch}\n`);
    log(`sha256 ${os}-${arch}: ${sum}`);
    assets.push(bin, sumPath);
  }

  if (dryRun) {
    log(`dry-run: built ${assets.length} assets, stopping before tag/publish`);
    return;
  }

  log(`tagging ${tag}`);
  await $`git tag ${tag}`;
  await $`git push origin ${tag}`;

  log(`publishing release on ${REPO}`);
  const prereleaseFlag = isPrerelease ? ["--prerelease"] : [];
  await $`gh release create ${tag} --repo ${REPO} --title ${tag} --generate-notes ${prereleaseFlag} ${assets}`;

  const url = await sh(
    `gh release view ${tag} --repo ${REPO} --json url --jq .url`
  );
  log(`done: ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
