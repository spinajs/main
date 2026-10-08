import 'mocha';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = resolve(PKG, 'lib/mjs');
const SPECIFIER = /(?:^|[;\s])(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** The packages the built module graph from `entry` imports, followed through its relative imports. */
function packagesImportedFrom(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [resolve(LIB, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        assert.ok(existsSync(target), `${file} imports ${spec}, which is not built`);
        queue.push(target);
      } else {
        packages.add(spec);
      }
    }
  }
  return packages;
}

/** What a fresh process has registered in DI after importing the root entry, and then the db entry when asked. */
async function registrationsAfterImport(withDb: boolean): Promise<Record<string, string[]>> {
  const script = `
    import { DI } from '@spinajs/di';
    import { AuthnEventSink, AuthnThrottle } from '@spinajs/authn/contracts';
    const root = await import('@spinajs/authn-totp');
    if (process.argv[1] === 'db') await import('@spinajs/authn-totp/db');
    const names = (t) => (DI.getRegisteredTypes(t) ?? []).map((x) => x.name);
    process.stdout.write(JSON.stringify({ migrations: names('__migrations__'), throttles: names(AuthnThrottle), sinks: names(AuthnEventSink), stores: names(root.MfaSecretStore) }) + '\\n', () => process.exit(0));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, withDb ? 'db' : 'root'], { cwd: PKG, maxBuffer: 16 * 1024 * 1024 });
  const line = stdout
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{"migrations"'))
    .pop();
  assert.ok(line, `no result line in: ${stdout}`);
  return JSON.parse(line);
}

/**
 * Why the lib/cjs of authn-totp or of authn-orm cannot stand for its src, or null when both can. The build info, not
 * each output, dates the last cjs build: tsc leaves an output file alone when its content did not change.
 */
function staleCjs(): string | null {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const pkg of [PKG, resolve(PKG, '../authn-orm')]) {
    const info = resolve(pkg, 'lib/tsconfig.cjs.tsbuildinfo');
    if (!existsSync(resolve(pkg, 'lib/cjs/index.js')) || !existsSync(info)) return `${relative(PKG, pkg) || '.'}/lib/cjs is not built`;
    const built = statSync(info).mtimeMs;
    const newer = files(resolve(pkg, 'src')).find((f) => statSync(f).mtimeMs > built);
    if (newer) return `${relative(PKG, newer)} changed after the last cjs build`;
  }
  return null;
}

/** The authn-orm files a fresh CommonJS process holds in require.cache after requiring `entry`, relative to authn-orm. */
async function authnOrmFilesRequiredBy(entry: string): Promise<string[]> {
  const script = `require(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify(Object.keys(require.cache)) + '\\n', () => process.exit(0));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { cwd: PKG, maxBuffer: 16 * 1024 * 1024 });
  const line = stdout
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('['))
    .pop();
  assert.ok(line, `no result line in: ${stdout}`);
  const marker = '/authn-orm/';
  return (JSON.parse(line) as string[]).map((f) => f.replace(/\\/g, '/')).flatMap((f) => (f.includes(marker) ? [f.slice(f.lastIndexOf(marker) + marker.length)] : []));
}

describe('v3 entry points: authn-orm is opt-in', function () {
  this.timeout(120000);

  it('the root entry imports only the side-effect-free cipher of authn-orm', () => {
    const root = packagesImportedFrom('index.js');
    assert.ok(!root.has('@spinajs/authn-orm'), 'the root entry reaches the main entry of authn-orm');
    assert.ok(root.has('@spinajs/authn-orm/cipher'));
    assert.ok(packagesImportedFrom('db.js').has('@spinajs/authn-orm'), 'the scan follows the db entry into authn-orm');
  });

  it('importing the root entry registers no authn-orm migration, DB default or MFA store', async () => {
    const r = await registrationsAfterImport(false);
    assert.ok(!r.migrations.includes('AuthnInitial_2026_10_02_00_00_00'), r.migrations.join());
    assert.ok(!r.migrations.includes('AuthnFromUserMetadata_2026_10_02_00_01_00'), r.migrations.join());
    assert.ok(!r.throttles.includes('DbAuthnThrottle'), r.throttles.join());
    assert.ok(!r.sinks.includes('DbAuthnAuditSink'), r.sinks.join());
    assert.deepStrictEqual(r.stores, []);
  });

  it('importing @spinajs/authn-totp/db registers DbMfaSecretStore and loads authn-orm on purpose', async () => {
    const r = await registrationsAfterImport(true);
    assert.deepStrictEqual(r.stores, ['DbMfaSecretStore']);
    assert.ok(r.migrations.includes('AuthnFromUserMetadata_2026_10_02_00_01_00'), r.migrations.join());
    assert.ok(r.throttles.includes('DbAuthnThrottle'), r.throttles.join());
  });

  it('requiring the CommonJS root entry loads only the cipher and identity files of authn-orm', async function () {
    const stale = staleCjs();
    if (stale) {
      console.warn(`      skipped: lib/cjs is not built from the current src (${stale}); run the cjs build`);
      this.skip();
    }
    const root = await authnOrmFilesRequiredBy('@spinajs/authn-totp');
    assert.deepStrictEqual([...root].sort(), ['lib/cjs/identity.js', 'lib/cjs/mfa/cipher.js']);
    assert.ok((await authnOrmFilesRequiredBy('@spinajs/authn-totp/db')).includes('lib/cjs/index.js'), 'the db entry loads the main entry');
  });
});
