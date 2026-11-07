#!/usr/bin/env node
// Usage (from a workspace script): node ../../scripts/require-ckit.mjs [--strict] <command...>
// Runs <command> when every ckit package the workspace lists is linked. Otherwise prints a SKIP line and exits 0,
// so the public monorepo stays green without ckit access; --strict (publishing) fails instead of skipping.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ckitPackagesOf } from './ckit-workspaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args[0] === '--strict';
const command = (strict ? args.slice(1) : args).join(' ');
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));

if (!command) {
  console.error('require-ckit: no command given');
  process.exit(1);
}

const listed = ckitPackagesOf(manifest).map((name) => ({ name, dir: path.join(ROOT, 'node_modules', '@coderush', `ckit-${name}`) }));
const linked = ({ dir }) => fs.existsSync(path.join(dir, 'package.json'));
const unlinked = listed.filter((entry) => !linked(entry));
const unbuilt = listed.filter((entry) => linked(entry) && !fs.existsSync(path.join(entry.dir, 'dist')));

if (unbuilt.length > 0) {
  console.error(`require-ckit: ${unbuilt.map(({ name }) => `ckit-${name}`).join(', ')} linked but has no dist/: build ckit first (npm run build in the ckit checkout)`);
  process.exit(1);
}

if (unlinked.length > 0) {
  if (strict) {
    console.error(`require-ckit: ${manifest.name} needs ${unlinked.map(({ name }) => `ckit-${name}`).join(', ')}; link ckit first (npm run link:ckit)`);
    process.exit(1);
  }
  console.log(`SKIP ${manifest.name}: ckit is not linked (npm run link:ckit)`);
  process.exit(0);
}

const result = spawnSync(command, { stdio: 'inherit', shell: true });
if (result.error) {
  console.error(`require-ckit: failed to run "${command}": ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`require-ckit: "${command}" was terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
