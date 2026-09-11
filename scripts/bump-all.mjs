/**
 * Bumps the version of every workspace package in lockstep.
 *
 * The monorepo releases all packages under ONE shared version (e.g. 2.0.492) and pins
 * internal dependencies to that exact version. This script:
 *
 *   1. asserts every package currently carries the same version - drift means someone
 *      edited a manifest by hand, and guessing a base version would publish garbage,
 *      so the script fails loudly instead;
 *   2. computes the next version (patch by default);
 *   3. writes it to every packages/<dir>/package.json AND rewrites every internal
 *      "@spinajs/*" entry in dependencies / devDependencies / peerDependencies /
 *      optionalDependencies to the exact new version;
 *   4. regenerates package-lock.json (`npm install --package-lock-only`) so the
 *      following `npm ci` in CI does not fail on manifest/lock drift.
 *
 * The root package.json is left untouched - it is never published.
 *
 * Usage
 * -----
 *   node scripts/bump-all.mjs                 patch bump (2.0.492 -> 2.0.493)
 *   node scripts/bump-all.mjs --bump=minor    2.0.492 -> 2.1.0
 *   node scripts/bump-all.mjs --bump=major    2.0.492 -> 3.0.0
 *   node scripts/bump-all.mjs --set=2.1.7     explicit version
 *   node scripts/bump-all.mjs --dry-run       print the plan, write nothing
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const PACKAGES_DIR = resolve(process.cwd(), "packages");
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const BUMP = (ARGS.find((a) => a.startsWith("--bump=")) ?? "--bump=patch").slice("--bump=".length);
const SET = ARGS.find((a) => a.startsWith("--set="))?.slice("--set=".length);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readPackages() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const manifestPath = join(PACKAGES_DIR, dirent.name, "package.json");

      if (!existsSync(manifestPath)) {
        return null;
      }

      return { folder: dirent.name, manifestPath, pkg: JSON.parse(readFileSync(manifestPath, "utf8")) };
    })
    .filter((p) => p !== null);
}

function nextVersion(current) {
  if (SET) {
    if (!/^\d+\.\d+\.\d+$/.test(SET)) {
      fail(`--set expects x.y.z, got "${SET}"`);
    }
    return SET;
  }

  const [major, minor, patch] = current.split(".").map(Number);

  switch (BUMP) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      fail(`--bump expects patch|minor|major, got "${BUMP}"`);
  }
}

const packages = readPackages();

if (packages.length === 0) {
  fail(`no packages found in ${PACKAGES_DIR}`);
}

const versions = new Set(packages.map((p) => p.pkg.version));

if (versions.size !== 1) {
  const drift = packages
    .map((p) => `  ${p.pkg.name ?? p.folder} ${p.pkg.version}`)
    .join("\n");
  fail(`packages are not in lockstep - fix the drift by hand before bumping:\n${drift}`);
}

const current = [...versions][0];
const next = nextVersion(current);
const internalNames = new Set(packages.map((p) => p.pkg.name).filter(Boolean));

let rewrittenDeps = 0;

for (const { pkg } of packages) {
  pkg.version = next;

  for (const section of DEP_SECTIONS) {
    for (const dep of Object.keys(pkg[section] ?? {})) {
      if (internalNames.has(dep)) {
        pkg[section][dep] = next;
        rewrittenDeps++;
      }
    }
  }
}

console.log(`${current} -> ${next}  (${packages.length} packages, ${rewrittenDeps} internal dependency pins)${DRY_RUN ? "  [dry run]" : ""}`);

if (DRY_RUN) {
  process.exit(0);
}

for (const { manifestPath, pkg } of packages) {
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// Keep the committed lock file in sync with the rewritten manifests - build.yml runs
// `npm ci`, which fails on any manifest/lock drift.
//
// The flags are all about how long this takes and whether you can tell it is alive:
//
//   --prefer-offline  build.yml runs `npm ci` immediately before this, so every tarball and
//                     every piece of registry metadata is already in the npm cache. Only the
//                     INTERNAL @spinajs/* pins changed above; the external graph is byte for
//                     byte what `npm ci` just resolved. Re-fetching it from the registry is
//                     pure latency, and on a slow registry day it is minutes of it.
//   --no-audit        two more network round trips that cannot influence the lock file.
//   --no-fund
//
// stdout is inherited rather than piped so npm's progress reaches the workflow log live. It
// used to be captured and printed only on failure, which meant a slow run and a hung run
// looked identical from the outside - a step logging "regenerating package-lock.json ..." and
// then nothing for six minutes reads as dead, and a release got cancelled on that guess.
// stderr stays piped so `fail` can still quote the actual error.
console.log("regenerating package-lock.json ...");

const lock = spawnSync("npm install --package-lock-only --prefer-offline --no-audit --no-fund", {
  shell: true,
  encoding: "utf8",
  stdio: ["ignore", "inherit", "pipe"],
});

if (lock.status !== 0) {
  fail(`npm install --package-lock-only failed:\n${lock.stderr ?? ""}`);
}

console.log("done");
