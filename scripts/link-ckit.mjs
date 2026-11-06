#!/usr/bin/env node
// Links the local ckit checkout into node_modules/@coderush for every workspace with a "ckit" field and pins
// the checkout's commit in that workspace's ckit.lock. --check verifies the pin.
// npm install and npm ci prune the links (they are not dependencies): rerun this after either.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ckitPackagesOf, ckitWorkspaces } from './ckit-workspaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CKIT_PATH = path.resolve(process.env.CKIT_PATH ?? path.join(ROOT, '..', '..', 'coderush', 'ckit'));
const SCOPE_DIR = path.join(ROOT, 'node_modules', '@coderush');
const LOCK = 'ckit.lock';

function fail(message) {
  console.error(`link:ckit: ${message}`);
  process.exit(1);
}

function checkout() {
  const head = spawnSync('git', ['-C', CKIT_PATH, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) fail(`${CKIT_PATH} is not a git checkout: ${(head.stderr ?? '').trim()}`);
  const status = spawnSync('git', ['-C', CKIT_PATH, 'status', '--porcelain'], { encoding: 'utf8' });
  return { commit: head.stdout.trim(), dirty: (status.stdout ?? '').trim() !== '' };
}

const workspaces = ckitWorkspaces(ROOT);
const packages = [...new Set(workspaces.flatMap(({ manifest }) => ckitPackagesOf(manifest)))].sort();
const check = process.argv.includes('--check');

if (packages.length === 0) {
  console.log('link:ckit: no workspace lists ckit packages');
  process.exit(0);
}

if (!fs.existsSync(CKIT_PATH)) fail(`ckit checkout not found at ${CKIT_PATH} (set CKIT_PATH to override)`);

const { commit, dirty } = checkout();

if (check) {
  const stale = workspaces.filter(({ dir }) => {
    const file = path.join(dir, LOCK);
    return !fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).commit !== commit;
  });
  if (stale.length > 0) fail(`${stale.map(({ manifest }) => manifest.name).join(', ')}: ${LOCK} does not pin ckit ${commit}; run npm run link:ckit and commit ${LOCK}`);
  console.log(`link:ckit: ${LOCK} pins ckit ${commit}`);
  process.exit(0);
}

for (const name of packages) {
  const source = path.join(CKIT_PATH, 'packages', name);
  if (!fs.existsSync(path.join(source, 'package.json')) || !fs.existsSync(path.join(source, 'dist'))) {
    fail(`@coderush/ckit-${name} is missing at ${source}: build ckit first: npm run build in ${CKIT_PATH}`);
  }
}

fs.mkdirSync(SCOPE_DIR, { recursive: true });
for (const name of packages) {
  const source = path.join(CKIT_PATH, 'packages', name);
  const link = path.join(SCOPE_DIR, `ckit-${name}`);
  // lstat, not exists: a dangling junction reports as missing but still blocks symlinkSync.
  // Never remove recursively here: on Windows a recursive delete follows junctions and wipes the ckit checkout.
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) fs.unlinkSync(link);
  else if (existing) fail(`${link} exists and is not a link; remove it by hand, then run npm run link:ckit again`);
  fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`  @coderush/ckit-${name} -> ${source}`);
}

for (const { dir, manifest } of workspaces) {
  fs.writeFileSync(path.join(dir, LOCK), `${JSON.stringify({ commit, dirty, packages: ckitPackagesOf(manifest).sort() }, null, 2)}\n`);
}
if (dirty) console.warn(`link:ckit: ${CKIT_PATH} has uncommitted changes; ${LOCK} pins ${commit} without them`);
console.log(`link:ckit: linked ${packages.length} package(s) from ${CKIT_PATH} at ${commit}`);
console.log('link:ckit: npm install and npm ci remove the links; run npm run link:ckit again after either');
