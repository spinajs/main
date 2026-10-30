/**
 * Checks what every public workspace package would publish: publint for package.json / exports
 * mistakes, and @arethetypeswrong/cli for types that do not resolve for ESM consumers.
 * Runs against the built lib/, so build first.
 *
 * Usage
 * -----
 *   node scripts/check-packages.mjs                  every public package
 *   node scripts/check-packages.mjs log http         only these
 *   node scripts/check-packages.mjs --no-attw        publint only (attw packs each package, slow)
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';
import { manifestInFiles } from './manifest-field.mjs';

const PACKAGES_DIR = resolve(process.cwd(), 'packages');
const ARGS = process.argv.slice(2);
const ATTW = !ARGS.includes('--no-attw');
const ONLY = ARGS.filter((a) => !a.startsWith('--'));

const ATTW_IGNORE_PER_PACKAGE = {
  // Exports only node / browser conditions, so a bundler has to pick one.
  electron: ['no-resolution'],
};

const packages = readdirSync(PACKAGES_DIR)
  .filter((name) => ONLY.length === 0 || ONLY.includes(name))
  .map((name) => ({ name, dir: join(PACKAGES_DIR, name), file: join(PACKAGES_DIR, name, 'package.json') }))
  .filter(({ file }) => existsSync(file))
  .map((p) => ({ ...p, pkg: JSON.parse(readFileSync(p.file, 'utf8')) }))
  .filter(({ pkg }) => pkg.private !== true);

let failed = 0;

for (const { name, dir, pkg } of packages) {
  const problems = [];

  const { messages } = await publint({ pkgDir: dir, level: 'warning', strict: false });
  for (const m of messages) problems.push(`publint ${m.type}: ${formatMessage(m, pkg) ?? m.code}`);

  if (pkg.spinajs?.manifest) {
    if (!manifestInFiles(pkg)) problems.push(`spinajs.manifest ${pkg.spinajs.manifest} is not covered by "files"`);
    else if (existsSync(join(dir, 'lib')) && !existsSync(join(dir, pkg.spinajs.manifest))) problems.push(`spinajs.manifest ${pkg.spinajs.manifest} was not built (npm run build:fragments)`);
  }

  if (ATTW) {
    // attw is a .cmd shim on windows, so it goes through a shell.
    const ignores = ATTW_IGNORE_PER_PACKAGE[name] ?? [];
    const ignoreFlag = ignores.length ? `--ignore-rules ${ignores.join(' ')}` : '';
    const proc = spawnSync(`npx --no-install attw --pack "${dir}" --profile esm-only ${ignoreFlag} --format ascii`, { shell: true, encoding: 'utf8' });
    if (proc.status !== 0) problems.push(`attw:\n${`${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim()}`);
  }

  if (problems.length > 0) {
    failed++;
    console.log(`\n✖ ${pkg.name ?? name}\n  ${problems.join('\n  ')}`);
  } else {
    console.log(`✔ ${pkg.name ?? name}`);
  }
}

console.log(`\n${packages.length - failed}/${packages.length} packages clean`);
process.exitCode = failed > 0 ? 1 : 0;
