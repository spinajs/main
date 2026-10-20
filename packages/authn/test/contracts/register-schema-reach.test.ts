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

// The package whose schema owns a key: the longest prefix listed, else @spinajs/authn. The authn schema keeps the keys
// that a package not depending on the fragment's package reads.
const OWNERS: readonly (readonly [string, string])[] = [
  ['authn.session', 'authn-session'],
  ['authn.session.expiration.maxLifetime', 'authn'],
  ['authn.local', 'authn-local'],
  ['authn.token', 'authn-token'],
  ['authn.token.prefix', 'authn'],
  ['authn.token.headerName', 'authn'],
  ['authn.jwt', 'authn-token'],
  ['authn.keys', 'authn-keys'],
  ['authn.keys.assertion.typ', 'authn'],
  ['authn.mfa.totp', 'authn-totp'],
  ['authn.http', 'authn-http'],
  ['authn.http.trustProxy', 'authn'],
  ['authn.oidc', 'authn-oidc'],
];

function ownerOf(path: string): string {
  const matching = OWNERS.filter(([prefix]) => path === prefix || path.startsWith(`${prefix}.`));
  return matching.sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? 'authn';
}

const READ_PATHS = [/@Config\(\s*['"](authn(?:\.\w+)*)/g, /@AutoinjectService\(\s*['"](authn(?:\.\w+)*)/g, /\bservice(?:<[^>]*>)?\(\s*['"](authn(?:\.\w+)*)/g, /\.get(?:<[^>]*>)?\(\s*['"](authn(?:\.\w+)*)/g];
const PATH_LITERALS = /(['"`])(authn(?:\.\w+)+)\1/g;

/** The authn.* paths `text` reads; 'authn' for a read the patterns cannot name. */
function pathsRead(text: string): string[] {
  const code = text.replace(COMMENTS, '$1');
  const paths = new Set(READ_PATHS.flatMap((r) => [...code.matchAll(r)].map((m) => m[1])));
  if (GET_CALL.test(code)) for (const m of code.matchAll(PATH_LITERALS)) paths.add(m[2]);
  return paths.size > 0 ? [...paths] : ['authn'];
}

// Only a side-effect import is sure to load a registration: TS drops an import whose names are used as types only.
const sideEffectImport = (pkg: string) => new RegExp(`^\\s*import\\s+['"]@spinajs/${pkg}/register-schema['"]`, 'm');
const REGISTERS_AT_IMPORT = /^\s*registerConfigurationSchemaAtImport\(/m;

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

/** The texts of `file` and of the modules of its package it loads through relative imports. */
function reachedTexts(file: string): string[] {
  const seen = new Set([file]);
  const queue = [file];
  const texts: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    const text = readFileSync(current, 'utf8');
    texts.push(text);
    for (const next of relativeImports(current, text)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return texts;
}

function dependenciesOf(pkg: string): string[] {
  const json = JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8')) as { dependencies?: object; peerDependencies?: object };
  return Object.keys({ ...json.dependencies, ...json.peerDependencies });
}

/** The owners of what `file` reads whose registration it does not load. A package it does not depend on is not asked for. */
function missingRegistrations(file: string): string[] {
  const pkg = relative(PACKAGES, file).split(sep)[0];
  const texts = reachedTexts(file);
  const owners = new Set(pathsRead(readFileSync(file, 'utf8')).map(ownerOf));
  return [...owners].filter((owner) => {
    if (owner === pkg) return !texts.some((t) => REGISTERS_AT_IMPORT.test(t));
    if (owner !== 'authn' && !dependenciesOf(pkg).includes(`@spinajs/${owner}`)) return false;
    return !texts.some((t) => sideEffectImport(owner).test(t));
  });
}

// Checked per module rather than per package index: a module that reads authn.* can load without the index, by a
// directory scan or a CLI command, after the Configuration resolved.
describe('every module outside @spinajs/authn that reads authn.* loads the registration of the schemas that own it', () => {
  it('through its own imports', function () {
    // Reads every source file of the repository.
    this.timeout(20000);
    const readers = readdirSync(PACKAGES)
      .filter((pkg) => pkg !== 'authn')
      .flatMap((pkg) => sources(join(PACKAGES, pkg, 'src')))
      .filter((file) => readsAuthn(readFileSync(file, 'utf8')));

    expect(readers.length, 'the scan finds the known readers').to.be.greaterThan(30);
    const missing = readers.flatMap((file) => missingRegistrations(file).map((owner) => `${relative(PACKAGES, file).split(sep).join('/')}: ${owner}`));
    expect(missing).to.deep.eq([]);
  });

  it('names the owner of a key by its longest listed prefix', () => {
    expect(['authn.session.cookie', 'authn.session.expiration.maxLifetime', 'authn.token', 'authn.token.prefix', 'authn.jwt.issuers', 'authn.mfa.totp', 'authn.mfa.steps', 'authn.http.csrf', 'authn.http.trustProxy', 'authn.throttle'].map(ownerOf)).to.deep.eq([
      'authn-session',
      'authn',
      'authn-token',
      'authn',
      'authn-token',
      'authn-totp',
      'authn',
      'authn-http',
      'authn',
      'authn',
    ]);
  });
});
