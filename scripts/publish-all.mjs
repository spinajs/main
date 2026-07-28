/**
 * Publishes every workspace package one by one.
 *
 * Unlike `npm publish --workspaces`, a failing package does NOT abort the run:
 * every remaining package is still attempted and a summary is printed at the end.
 *
 * A version that is already on the registry is reported as SKIPPED, not as a failure,
 * so re-running the script after a partial publish is safe.
 *
 * Any extra CLI arguments are forwarded to `npm publish`, e.g.:
 *   node scripts/publish-all.mjs --dry-run
 *   node scripts/publish-all.mjs --tag next
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const PACKAGES_DIR = resolve(process.cwd(), "packages");
const NPM_ARGS = process.argv.slice(2);

const RESULT = {
  PUBLISHED: "published",
  SKIPPED: "skipped",
  FAILED: "failed",
};

function readPackages() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const dir = join(PACKAGES_DIR, dirent.name);
      const manifest = join(dir, "package.json");

      if (!existsSync(manifest)) {
        return null;
      }

      const pkg = JSON.parse(readFileSync(manifest, "utf8"));

      return {
        dir,
        folder: dirent.name,
        name: pkg.name,
        version: pkg.version,
        private: pkg.private === true,
        deps: Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }),
      };
    })
    .filter((p) => p !== null);
}

/**
 * Orders packages so that a package is always published after the workspace
 * packages it depends on. Cycles (if any) fall back to alphabetical order.
 */
function topoSort(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const sorted = [];
  const state = new Map();

  const visit = (pkg) => {
    if (state.get(pkg.name) === "done") return;
    if (state.get(pkg.name) === "visiting") return; // cycle - leave current position

    state.set(pkg.name, "visiting");

    for (const dep of pkg.deps) {
      const local = byName.get(dep);
      if (local) visit(local);
    }

    state.set(pkg.name, "done");
    sorted.push(pkg);
  };

  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(pkg);
  }

  return sorted;
}

function isAlreadyPublished(output) {
  return /EPUBLISHCONFLICT|cannot publish over|previously published versions/i.test(output);
}

function publish(pkg) {
  const proc = spawnSync("npm", ["publish", ...NPM_ARGS], {
    cwd: pkg.dir,
    shell: true,
    encoding: "utf8",
  });

  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim();

  if (proc.status === 0) {
    return { result: RESULT.PUBLISHED, output };
  }

  if (isAlreadyPublished(output)) {
    return { result: RESULT.SKIPPED, reason: `${pkg.version} already on registry`, output };
  }

  const reason = output.split(/\r?\n/).find((l) => /^npm (error|ERR!)/.test(l)) ?? `exit code ${proc.status}`;

  return { result: RESULT.FAILED, reason: reason.trim(), output };
}

const packages = topoSort(readPackages());
const report = [];

console.log(`Publishing ${packages.length} package(s) from ${PACKAGES_DIR}\n`);

for (const pkg of packages) {
  if (pkg.private) {
    console.log(`- ${pkg.name} : SKIPPED (private)`);
    report.push({ pkg, result: RESULT.SKIPPED, reason: "private package" });
    continue;
  }

  console.log(`- ${pkg.name}@${pkg.version} : publishing ...`);

  const { result, reason, output } = publish(pkg);

  if (result === RESULT.PUBLISHED) {
    console.log(`  OK`);
  } else if (result === RESULT.SKIPPED) {
    console.log(`  SKIPPED (${reason})`);
  } else {
    console.log(`  FAILED (${reason})`);
    console.log(output.replace(/^/gm, "  | "));
  }

  report.push({ pkg, result, reason });
}

const published = report.filter((r) => r.result === RESULT.PUBLISHED);
const skipped = report.filter((r) => r.result === RESULT.SKIPPED);
const failed = report.filter((r) => r.result === RESULT.FAILED);

console.log(`\n=== Summary ===`);
console.log(`published : ${published.length}`);
console.log(`skipped   : ${skipped.length}`);
console.log(`failed    : ${failed.length}`);

if (skipped.length) {
  console.log(`\nSkipped:`);
  for (const r of skipped) console.log(`  ${r.pkg.name} - ${r.reason}`);
}

if (failed.length) {
  console.log(`\nFailed:`);
  for (const r of failed) console.log(`  ${r.pkg.name}@${r.pkg.version} - ${r.reason}`);

  // A dependent published against a dependency that never made it to the registry
  // installs broken, so call that out explicitly.
  const failedNames = new Set(failed.map((r) => r.pkg.name));
  const orphaned = published.filter((r) => r.pkg.deps.some((d) => failedNames.has(d)));

  if (orphaned.length) {
    console.log(`\nWARNING - published, but depend on a package that failed:`);
    for (const r of orphaned) {
      const broken = r.pkg.deps.filter((d) => failedNames.has(d));
      console.log(`  ${r.pkg.name} -> ${broken.join(", ")}`);
    }
  }

  process.exit(1);
}
