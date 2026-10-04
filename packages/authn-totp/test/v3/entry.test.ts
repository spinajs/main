import 'mocha';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
    console.log(JSON.stringify({ migrations: names('__migrations__'), throttles: names(AuthnThrottle), sinks: names(AuthnEventSink), stores: names(root.MfaSecretStore) }));
    process.exit(0);
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
});
