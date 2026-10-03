import * as chai from 'chai';
import 'mocha';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expect = chai.expect;

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('authz-rbac config fragment', () => {
  // @spinajs/configuration loads every `node_modules/@spinajs/*/lib/mjs/config/**/!(*.*).js` (cjs: lib/cjs/config).
  const compiled = join(PACKAGE, 'lib', 'mjs', 'config', 'admin.js');

  it('compiles to lib/mjs/config/admin.js, a file name the configuration loader picks up', () => {
    expect(existsSync(compiled)).to.equal(true);
    expect(basename(compiled, '.js')).to.not.include('.');
    const linked = join(PACKAGE, '..', '..', 'node_modules', '@spinajs', 'authz-rbac', 'lib', 'mjs', 'config', 'admin.js');
    expect(realpathSync(linked)).to.equal(realpathSync(compiled));
  });

  it('exports the authz.admin.guard defaults as a plain mutable object and nothing else', async () => {
    const mod = (await import(pathToFileURL(compiled).href)) as Record<string, unknown>;
    expect(Object.keys(mod)).to.deep.equal(['default']);
    expect(mod.default).to.deep.equal({ authz: { admin: { guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true } } } });
    const cfg = mod.default as { authz: { admin: { guard: object } } };
    expect(Object.isFrozen(cfg) || Object.isFrozen(cfg.authz) || Object.isFrozen(cfg.authz.admin) || Object.isFrozen(cfg.authz.admin.guard)).to.equal(false);
  });
});
