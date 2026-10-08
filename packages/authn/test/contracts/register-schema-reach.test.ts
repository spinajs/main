import 'mocha';
import { expect } from 'chai';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A read of authn.* by @Config, @AutoinjectService, service() or a Configuration lookup.
const READS = [
  /@Config\(\s*['"]authn\./,
  /@AutoinjectService\(\s*['"]authn\./,
  /\bservice(?:<[^>]*>)?\(\s*['"]authn\./,
  /\.get(?:<[^>]*>)?\(\s*['"]authn\./,
  /\.get(?:<[^>]*>)?\(\s*\[\s*['"]authn['"]/,
];

// A lookup through a constant (`const KEY = 'authn.x'; config.get(KEY)`): a literal that is a whole authn.* path, in a
// module that calls any `.get(`. Comments are left out; a message such as 'authn.x is not set' is not a whole path.
const PATH_LITERAL = /(['"`])authn(?:\.[A-Za-z0-9_]+)+\1/;
const GET_CALL = /\.get(?:<[^>]*>)?\(/;
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g;

function readsAuthn(text: string): boolean {
  const code = text.replace(COMMENTS, '$1');
  return READS.some((r) => r.test(code)) || (PATH_LITERAL.test(code) && GET_CALL.test(code));
}

// Only a side-effect import is sure to load it: TS drops an import whose names are used as types only.
const REGISTERS = /^\s*import\s+['"]@spinajs\/authn\/register-schema['"]/m;

const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The relative modules `file` loads, type-only imports left out. */
function relativeImports(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    if (m[1] || !m[2].startsWith('.')) continue;
    const base = resolve(dirname(file), m[2]);
    const found = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
    if (found) out.push(found);
  }
  return out;
}

/** Whether `file`, or a module of its package it loads through relative imports, imports the registration. */
function reachesRegistration(file: string): boolean {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    const current = queue.shift()!;
    const text = readFileSync(current, 'utf8');
    if (REGISTERS.test(text)) return true;
    for (const next of relativeImports(current, text)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// Checked per module rather than per package index: a module that reads authn.* can load without the index, by a
// directory scan or a CLI command, after the Configuration resolved.
describe('every module outside @spinajs/authn that reads authn.* loads @spinajs/authn/register-schema', () => {
  it('through its own imports', function () {
    // Reads every source file of the repository.
    this.timeout(20000);
    const readers = readdirSync(PACKAGES)
      .filter((pkg) => pkg !== 'authn')
      .flatMap((pkg) => sources(join(PACKAGES, pkg, 'src')))
      .filter((file) => readsAuthn(readFileSync(file, 'utf8')));

    expect(readers.length, 'the scan finds the known readers').to.be.greaterThan(30);
    expect(readers.filter((file) => !reachesRegistration(file)).map((file) => relative(PACKAGES, file).split(sep).join('/'))).to.deep.eq([]);
  });
});
