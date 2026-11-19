/**
 * Loads every public workspace package into one process and reports two classes with one name that register into
 * DI. The container refuses the second one ( BindException ), so an app that uses both packages would not boot.
 * Covers what registers on import ( `@Injectable`, top-level `DI.register` ). A package that fails to import fails
 * the check too, unless it is listed in SKIP. Runs against the built lib/, so build first.
 *
 * Usage
 * -----
 *   node scripts/check-di-names.mjs              every public package
 *   node scripts/check-di-names.mjs authz http   only these
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { BindException, Registry } from '@spinajs/di';

const PACKAGES_DIR = resolve(process.cwd(), 'packages');
const ONLY = process.argv.slice(2);

// Directory names of packages that cannot be imported outside their runtime, with the reason.
const SKIP = {};

const packages = readdirSync(PACKAGES_DIR)
  .filter((name) => ONLY.length === 0 || ONLY.includes(name))
  .filter((name) => !(name in SKIP))
  .map((name) => join(PACKAGES_DIR, name, 'package.json'))
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter((pkg) => pkg.private !== true && pkg.exports?.['.']);

const clashes = new Map();
let current = '';

// Record each refusal and go on, so one run lists every clash instead of stopping at the first.
const register = Registry.prototype.register;
Registry.prototype.register = function (name, type) {
  try {
    return register.call(this, name, type);
  } catch (err) {
    if (!(err instanceof BindException)) {
      throw err;
    }
    clashes.set(err.message, current);
  }
};

const unloadable = [];
for (const pkg of packages) {
  current = pkg.name;
  try {
    await import(pkg.name);
  } catch (err) {
    unloadable.push(`${pkg.name}: ${err.message.split('\n')[0]}`);
  }
}

if (unloadable.length > 0) {
  console.error(`Not checked, the package does not load on its own (${unloadable.length}); fix it or add it to SKIP:`);
  unloadable.forEach((u) => console.error(`  ${u}`));
}

if (clashes.size > 0) {
  console.error(`\nTwo classes with one name register into DI (${clashes.size}):`);
  for (const [message, pkg] of clashes) {
    console.error(`  while loading ${pkg}: ${message}`);
  }
}

if (unloadable.length > 0 || clashes.size > 0) {
  process.exit(1);
}

const skipped = Object.keys(SKIP).length;
console.log(`\n${packages.length} packages loaded${skipped ? `, ${skipped} skipped` : ''}, no two DI classes share a name.`);
