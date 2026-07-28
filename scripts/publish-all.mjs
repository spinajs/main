/**
 * Publishes every workspace package one by one.
 *
 * Unlike `npm publish --workspaces`, a failing package does NOT abort the run:
 * every remaining package is still attempted and a summary is printed at the end.
 *
 * Authentication
 * --------------
 * The script authenticates once, up front, before publishing anything - so a missing
 * login fails in 2 seconds instead of halfway through the run. If nobody is logged in
 * it runs `npm login`, which opens the browser flow.
 *
 * Versions already on the registry are detected BEFORE publishing and skipped, so a
 * re-run after a partial publish is safe and does not waste a 2FA prompt on them.
 *
 * If a publish still asks for a one-time password, the script re-runs that single
 * publish attached to the terminal so npm can print the auth URL and wait for you.
 * With 2FA set to "authorization and writes" npm asks per package - to publish many
 * packages unattended use a granular/automation token instead:
 *
 *   npm token create --read-only=false      (or create it on npmjs.com)
 *   set NPM_TOKEN / add //registry.npmjs.org/:_authToken=<token> to .npmrc
 *
 * Usage
 * -----
 *   node scripts/publish-all.mjs                 publish everything not yet on the registry
 *   node scripts/publish-all.mjs --dry-run       go through the motions, upload nothing
 *   node scripts/publish-all.mjs --login         force a fresh `npm login` first
 *   node scripts/publish-all.mjs --otp=123456    supply a one-time password up front
 *   node scripts/publish-all.mjs --tag next      any other flag is forwarded to `npm publish`
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const PACKAGES_DIR = resolve(process.cwd(), "packages");

const ARGS = process.argv.slice(2);
const FORCE_LOGIN = ARGS.includes("--login");
const NPM_ARGS = ARGS.filter((a) => a !== "--login");
const INTERACTIVE = process.stdin.isTTY === true;

const RESULT = {
  PUBLISHED: "published",
  SKIPPED: "skipped",
  FAILED: "failed",
};

/** Runs npm and captures its output. */
function npm(args, cwd = process.cwd()) {
  // npm is a .cmd shim on windows, so it has to go through a shell. Passing the whole
  // command as a single string (instead of an args array) avoids the DEP0190 warning.
  const proc = spawnSync(["npm", ...args].join(" "), { cwd, shell: true, encoding: "utf8" });

  return {
    ok: proc.status === 0,
    status: proc.status,
    output: `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim(),
  };
}

/** Runs npm attached to the terminal, so it can prompt and open the browser. */
function npmInteractive(args, cwd = process.cwd()) {
  const proc = spawnSync(["npm", ...args].join(" "), { cwd, shell: true, stdio: "inherit" });

  return { ok: proc.status === 0, status: proc.status, output: "" };
}

function needsOtp(output) {
  return /EOTP|one-time password|otp/i.test(output);
}

function isAlreadyPublished(output) {
  return /EPUBLISHCONFLICT|cannot publish over|previously published versions/i.test(output);
}

/**
 * Makes sure we are logged in before touching any package, running the browser
 * login flow when we are not. Returns the npm username.
 */
function authenticate() {
  if (!FORCE_LOGIN) {
    const who = npm(["whoami"]);

    if (who.ok && who.output) {
      console.log(`Authenticated as ${who.output}\n`);
      return who.output;
    }
  }

  if (!INTERACTIVE) {
    console.error("Not logged in to npm and no terminal available to log in from.");
    console.error("Set an auth token (NPM_TOKEN / .npmrc //registry.npmjs.org/:_authToken) and retry.");
    process.exit(1);
  }

  console.log("Not logged in to npm - starting login, follow the URL that npm prints below.\n");

  // stdio is inherited so npm can print the auth URL, open the browser and wait for it.
  npmInteractive(["login"]);

  const who = npm(["whoami"]);

  if (!who.ok || !who.output) {
    console.error("\nLogin did not complete - aborting without publishing anything.");
    process.exit(1);
  }

  console.log(`\nAuthenticated as ${who.output}\n`);
  return who.output;
}

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

/**
 * Asked before publishing, so already released versions never reach `npm publish`
 * and never trigger a 2FA prompt. Unknown answers (network trouble) publish anyway
 * and let the registry be the judge.
 */
function isOnRegistry(pkg) {
  const view = npm(["view", `${pkg.name}@${pkg.version}`, "version"]);

  if (view.ok) return view.output !== "";
  if (/E404|is not in this registry|no such package/i.test(view.output)) return false;

  return false;
}

function publish(pkg) {
  const attempt = npm(["publish", ...NPM_ARGS], pkg.dir);

  if (attempt.ok) {
    return { result: RESULT.PUBLISHED, output: attempt.output };
  }

  if (isAlreadyPublished(attempt.output)) {
    return { result: RESULT.SKIPPED, reason: `${pkg.version} already on registry` };
  }

  // npm wants a one-time password. It cannot ask us while its output is piped, so
  // hand the terminal over and let it print the auth URL / prompt for the code.
  if (needsOtp(attempt.output)) {
    if (!INTERACTIVE) {
      return { result: RESULT.FAILED, reason: "one-time password required (use an automation token)" };
    }

    console.log(`  needs a one-time password - handing over to npm:\n`);

    const retry = npmInteractive(["publish", ...NPM_ARGS], pkg.dir);

    if (retry.ok) {
      return { result: RESULT.PUBLISHED, output: "" };
    }

    return { result: RESULT.FAILED, reason: `authentication failed (npm exit code ${retry.status})` };
  }

  const reason = attempt.output.split(/\r?\n/).find((l) => /^npm (error|ERR!)/.test(l)) ?? `exit code ${attempt.status}`;

  return { result: RESULT.FAILED, reason: reason.trim(), output: attempt.output };
}

authenticate();

const packages = topoSort(readPackages());
const report = [];

console.log(`Publishing ${packages.length} package(s) from ${PACKAGES_DIR}\n`);

for (const pkg of packages) {
  if (pkg.private) {
    console.log(`- ${pkg.name} : SKIPPED (private)`);
    report.push({ pkg, result: RESULT.SKIPPED, reason: "private package" });
    continue;
  }

  if (isOnRegistry(pkg)) {
    console.log(`- ${pkg.name}@${pkg.version} : SKIPPED (already on registry)`);
    report.push({ pkg, result: RESULT.SKIPPED, reason: `${pkg.version} already on registry` });
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
    if (output) console.log(output.replace(/^/gm, "  | "));
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
