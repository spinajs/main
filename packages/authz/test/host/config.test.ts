import * as chai from 'chai';
import 'mocha';
import Ajv from 'ajv';
import ajvFormats from 'ajv-formats';
import ajvKeywords from 'ajv-keywords';

import { AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_DEFAULTS, readDomainConfig, AUTHZ_LEGACY_KEYS, checkLegacyKeys, findLegacyKeys, AuthzConfigError, AuthzConfigBootstrapper } from '@spinajs/authz';
import { DI } from '@spinajs/di';

const expect = chai.expect;

function getter(root: Record<string, unknown>) {
  return (path: string[]): unknown => path.reduce<any>((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), root);
}

function newAjv(): any {
  const AjvCtor: any = (Ajv as any).default ?? Ajv;
  const ajv: any = new AjvCtor({ allErrors: true, removeAdditional: true, useDefaults: true, coerceTypes: true });
  (ajvFormats as any).default(ajv);
  (ajvKeywords as any).default(ajv);
  ajv.addKeyword('$configurationModule');
  return ajv;
}

const validConfig = () => ({
  permissions: { 'fs.read': { description: 'Read', fields: true, types: ['File'], implies: ['fs.list'] }, 'fs.list': {} },
  combine: { default: { algorithm: 'deny-overrides' }, types: { File: { algorithm: 'first-applicable', models: ['rbac'] } } },
  domains: { fs: { parent: 'root', combine: { default: { algorithm: 'permit-overrides' } }, disable: ['abac'], permissions: { 'fs.x': {} }, engine: { modelTimeoutMs: 500 }, fields: { neverRead: ['Secret'] }, cache: { ttlSeconds: 5 }, audit: { denials: false } } },
  principals: { anonymous: { enabled: false }, roleSwitch: { requirePassword: ['admin'] } },
  fields: { neverRead: ['Password'], write: { mode: 'reject' } },
  engine: { explain: true, modelTimeoutMs: 1000, maxDelegation: 0 },
  cache: { maxEntries: 0, ttlSeconds: 0.5 },
  audit: { denials: true, runAs: false, unscoped: true, service: 'MyAudit' },
  bus: { service: 'MyBus' },
  config: { rejectLegacyKeys: true },
});

describe('authz config schema', () => {
  const validate = (cfg: unknown) => {
    const ajv = newAjv();
    const ok = ajv.validate(AUTHZ_CONFIGURATION_SCHEMA, cfg);
    return { ok, errors: ajv.errors };
  };

  it('declares its module and id', () => {
    expect(AUTHZ_CONFIGURATION_SCHEMA.$configurationModule).to.equal('authz');
    expect(AUTHZ_CONFIGURATION_SCHEMA.$id).to.equal('spinajs/authz.configuration.schema.json');
  });

  it('accepts a valid config unchanged', () => {
    const cfg = validConfig();
    const copy = JSON.parse(JSON.stringify(cfg));
    expect(validate(cfg).ok).to.equal(true);
    expect(cfg).to.deep.equal(copy);
  });

  it('accepts an empty config and adds no defaults', () => {
    const cfg = {};
    expect(validate(cfg).ok).to.equal(true);
    expect(cfg).to.deep.equal({});
  });

  it('keeps sections that belong to other packages', () => {
    const cfg: any = { http: { x: 1 }, rbac: { roles: { a: {} } }, fs: { y: true }, engine: { explain: false } };
    expect(validate(cfg).ok).to.equal(true);
    expect(cfg.http).to.deep.equal({ x: 1 });
    expect(cfg.rbac).to.deep.equal({ roles: { a: {} } });
    expect(cfg.fs).to.deep.equal({ y: true });
  });

  it('rejects wrong types, each for its own reason', () => {
    const fails = (cfg: unknown, instancePath: string, keyword: string) => {
      const r = validate(cfg);
      expect(r.ok, JSON.stringify(cfg)).to.equal(false);
      expect(
        r.errors!.some((e: any) => e.instancePath === instancePath && e.keyword === keyword),
        JSON.stringify(r.errors),
      ).to.equal(true);
    };
    fails({ engine: { modelTimeoutMs: 'x' } }, '/engine/modelTimeoutMs', 'type');
    fails({ engine: { modelTimeoutMs: 0 } }, '/engine/modelTimeoutMs', 'minimum');
    fails({ domains: { root: {} } }, '/domains', 'not');
    fails({ domains: { 'bad name': {} } }, '/domains', 'pattern');
    fails({ combine: { default: {} } }, '/combine/default', 'required');
    fails({ combine: { types: {} } }, '/combine', 'required');
    fails({ fields: { write: { mode: 'drop' } } }, '/fields/write/mode', 'enum');
    fails({ audit: { service: '' } }, '/audit/service', 'minLength');
    fails({ bus: { service: '' } }, '/bus/service', 'minLength');
    fails({ cache: { maxEntries: -1 } }, '/cache/maxEntries', 'minimum');
    fails({ permissions: { a: { types: 'File' } } }, '/permissions/a/types', 'type');
  });
});

describe('authz defaults', () => {
  it('match the spec', () => {
    expect(AUTHZ_DEFAULTS.engine).to.deep.equal({ explain: false, modelTimeoutMs: 2000, maxDelegation: 2 });
    expect(AUTHZ_DEFAULTS.cache).to.deep.equal({ maxEntries: 10000, ttlSeconds: 60 });
    expect(AUTHZ_DEFAULTS.audit).to.deep.equal({ denials: true, runAs: true, unscoped: true });
    expect(AUTHZ_DEFAULTS.fields.neverRead).to.deep.equal(['Password']);
    expect(AUTHZ_DEFAULTS.fields.write.mode).to.equal('strip');
    expect(AUTHZ_DEFAULTS.principals.anonymous.enabled).to.equal(true);
    expect(AUTHZ_DEFAULTS.config.rejectLegacyKeys).to.equal(false);
    expect(AUTHZ_DEFAULTS.combine).to.deep.equal({ default: { algorithm: 'deny-overrides' } });
  });
});

describe('readDomainConfig', () => {
  it('returns the defaults without an authz key', () => {
    const c = readDomainConfig(getter({}), ['root']);
    expect(c.domain).to.equal('root');
    expect(c.parent).to.equal(undefined);
    expect(c.permissions).to.deep.equal({});
    expect(c.disable).to.deep.equal([]);
    expect(c.combine).to.deep.equal({ default: { algorithm: 'deny-overrides' } });
    expect(c.engine).to.deep.equal({ explain: false, modelTimeoutMs: 2000, maxDelegation: 2 });
    expect(c.fields).to.deep.equal({ neverRead: ['Password'], writeMode: 'strip' });
    expect(c.cache).to.deep.equal({ maxEntries: 10000, ttlSeconds: 60 });
    expect(c.audit).to.deep.equal({ denials: true, runAs: true, unscoped: true });
    expect(c.bus).to.deep.equal({});
    expect(c.principals).to.deep.equal({ anonymousEnabled: true });
  });

  it('reads root-only values', () => {
    const c = readDomainConfig(getter({ authz: validConfig() }), ['root']);
    expect(Object.keys(c.permissions)).to.deep.equal(['fs.read', 'fs.list']);
    expect(c.combine.types!.File.algorithm).to.equal('first-applicable');
    expect(c.engine).to.deep.equal({ explain: true, modelTimeoutMs: 1000, maxDelegation: 0 });
    expect(c.fields).to.deep.equal({ neverRead: ['Password'], writeMode: 'reject' });
    expect(c.cache).to.deep.equal({ maxEntries: 0, ttlSeconds: 0.5 });
    expect(c.audit).to.deep.equal({ denials: true, runAs: false, unscoped: true, service: 'MyAudit' });
    expect(c.bus).to.deep.equal({ service: 'MyBus' });
    expect(c.principals).to.deep.equal({ anonymousEnabled: false });
    expect(c.disable).to.deep.equal([]);
  });

  it('lets a child override one key and inherit the rest', () => {
    const c = readDomainConfig(getter({ authz: validConfig() }), ['root', 'fs']);
    expect(c.domain).to.equal('fs');
    expect(c.parent).to.equal('root');
    expect(c.engine).to.deep.equal({ explain: true, modelTimeoutMs: 500, maxDelegation: 0 });
    expect(c.fields).to.deep.equal({ neverRead: ['Secret'], writeMode: 'reject' });
    expect(c.cache).to.deep.equal({ maxEntries: 0, ttlSeconds: 5 });
    expect(c.audit).to.deep.equal({ denials: false, runAs: false, unscoped: true, service: 'MyAudit' });
    expect(c.bus).to.deep.equal({ service: 'MyBus' });
    expect(c.principals).to.deep.equal({ anonymousEnabled: false });
  });

  it('lets a grandchild inherit the parent override', () => {
    const cfg = { authz: { engine: { maxDelegation: 5 }, domains: { a: { engine: { modelTimeoutMs: 10 } }, b: { parent: 'a', engine: { explain: true } } } } };
    const c = readDomainConfig(getter(cfg), ['root', 'a', 'b']);
    expect(c.engine).to.deep.equal({ explain: true, modelTimeoutMs: 10, maxDelegation: 5 });
    expect(c.parent).to.equal('a');
  });

  it('takes combine from the nearest level, whole', () => {
    const cfg = { authz: { combine: { default: { algorithm: 'permit-overrides' }, types: { T: { algorithm: 'x' } } }, domains: { a: { combine: { default: { algorithm: 'first-applicable' } } }, b: { parent: 'a' }, c: {} } } };
    expect(readDomainConfig(getter(cfg), ['root', 'a', 'b']).combine).to.deep.equal({ default: { algorithm: 'first-applicable' } });
    expect(readDomainConfig(getter(cfg), ['root', 'c']).combine.default.algorithm).to.equal('permit-overrides');
    expect(readDomainConfig(getter(cfg), ['root']).combine.types!.T.algorithm).to.equal('x');
  });

  it('reads disable and permissions for this level only', () => {
    const cfg = { authz: { permissions: { 'r.p': {} }, domains: { a: { disable: ['m'], permissions: { 'a.p': { description: 'd' } } }, b: {} } } };
    const a = readDomainConfig(getter(cfg), ['root', 'a']);
    expect(a.disable).to.deep.equal(['m']);
    expect(Object.keys(a.permissions)).to.deep.equal(['a.p']);
    const b = readDomainConfig(getter(cfg), ['root', 'a', 'b']);
    expect(b.disable).to.deep.equal([]);
    expect(b.permissions).to.deep.equal({});
    expect(Object.keys(readDomainConfig(getter(cfg), ['root']).permissions)).to.deep.equal(['r.p']);
  });

  it('reads domains whose name contains a dot', () => {
    const cfg = { authz: { domains: { 'a.b': { engine: { explain: true } } } } };
    expect(readDomainConfig(getter(cfg), ['root', 'a.b']).engine.explain).to.equal(true);
  });

  const bad = (cfg: unknown, lineage: string[], domain: string, key: string) => {
    let err: unknown;
    try {
      readDomainConfig(getter({ authz: cfg as any }), lineage);
    } catch (e) {
      err = e;
    }
    expect(err, key).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.contain(`"${domain}"`);
    expect((err as Error).message).to.contain(key);
  };

  it('throws AuthzConfigError naming domain and key for wrong types', () => {
    bad({ engine: { modelTimeoutMs: 'x' } }, ['root'], 'root', 'engine.modelTimeoutMs');
    bad({ engine: { modelTimeoutMs: 0 } }, ['root'], 'root', 'engine.modelTimeoutMs');
    bad({ domains: { fs: { engine: { explain: 'yes' } } } }, ['root', 'fs'], 'fs', 'domains.fs.engine.explain');
    bad({ domains: { fs: { cache: { ttlSeconds: -1 } } } }, ['root', 'fs'], 'fs', 'cache.ttlSeconds');
    bad({ fields: { write: { mode: 'drop' } } }, ['root'], 'root', 'fields.write.mode');
    bad({ fields: { neverRead: 'x' } }, ['root'], 'root', 'fields.neverRead');
    bad({ audit: { service: 1 } }, ['root'], 'root', 'audit.service');
    bad({ combine: { default: {} } }, ['root'], 'root', 'combine');
    bad({ domains: { fs: { disable: 'x' } } }, ['root', 'fs'], 'fs', 'disable');
    bad({ domains: { fs: { permissions: { p: { types: 'x' } } } } }, ['root', 'fs'], 'fs', 'permissions');
    bad({ principals: { anonymous: { enabled: 'no' } } }, ['root'], 'root', 'principals.anonymous.enabled');
    bad({ engine: 5 }, ['root'], 'root', 'engine');
  });

  it('throws for wrong-typed containers', () => {
    bad({ domains: 5 }, ['root'], 'root', 'authz.domains');
    bad({ domains: [] }, ['root', 'fs'], 'fs', 'authz.domains');
    bad({ audit: { service: '' } }, ['root'], 'root', 'audit.service');
    bad({ bus: { service: '' } }, ['root'], 'root', 'bus.service');
    bad({ fields: { write: 'reject' } }, ['root'], 'root', 'fields.write');
    bad({ domains: { fs: { fields: { write: 5 } } } }, ['root', 'fs'], 'fs', 'domains.fs.fields.write');
    bad({ bus: 5 }, ['root'], 'root', 'authz.bus');
    bad({ principals: 5 }, ['root'], 'root', 'authz.principals');
    bad({ principals: { anonymous: 5 } }, ['root'], 'root', 'principals.anonymous');
    bad({ domains: { fs: 5 } }, ['root', 'fs'], 'fs', 'domains.fs');
    bad({ domains: { fs: [] } }, ['root', 'fs'], 'fs', 'domains.fs');
    bad({ cache: 'x' }, ['root'], 'root', 'authz.cache');
    bad({ audit: [] }, ['root'], 'root', 'authz.audit');
    bad({ fields: 'x' }, ['root'], 'root', 'authz.fields');
  });

  it('reads domains named like Object.prototype members', () => {
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const domains = JSON.parse(`{"${name}":{"engine":{"modelTimeoutMs":7}}}`);
      expect(readDomainConfig(getter({ authz: { domains } }), ['root', name]).engine.modelTimeoutMs, name).to.equal(7);
      expect(readDomainConfig(getter({ authz: {} }), ['root', name]).engine.modelTimeoutMs, name).to.equal(2000);
    }
  });

  it('does not resolve a prototype-named domain absent from a non-empty domains map', () => {
    const cfg = { authz: { domains: { other: { engine: { modelTimeoutMs: 7 } } } } };
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const c = readDomainConfig(getter(cfg), ['root', name]);
      expect(c.engine.modelTimeoutMs, name).to.equal(2000);
      expect(c.parent, name).to.equal(undefined);
      expect(c.disable, name).to.deep.equal([]);
    }
  });

  it('throws when authz itself is not an object', () => {
    for (const authz of ['x', 5, true, []]) {
      expect(() => readDomainConfig(getter({ authz } as any), ['root']), String(authz)).to.throw(AuthzConfigError, 'authz');
    }
  });

  it('ignores bus and principals set at domain level', () => {
    const cfg = { authz: { domains: { fs: { bus: { service: 'X' }, principals: { anonymous: { enabled: false } } } } } };
    const c = readDomainConfig(getter(cfg), ['root', 'fs']);
    expect(c.bus).to.deep.equal({});
    expect(c.principals).to.deep.equal({ anonymousEnabled: true });
  });

  it('returns a deeply frozen result', () => {
    const c = readDomainConfig(getter({ authz: validConfig() }), ['root', 'fs']);
    expect(Object.isFrozen(c)).to.equal(true);
    expect(Object.isFrozen(c.engine)).to.equal(true);
    expect(Object.isFrozen(c.fields.neverRead)).to.equal(true);
    expect(Object.isFrozen(c.combine)).to.equal(true);
    expect(Object.isFrozen(c.combine.default)).to.equal(true);
    expect(Object.isFrozen(c.permissions)).to.equal(true);
    expect(Object.isFrozen(c.permissions['fs.x'])).to.equal(true);
    expect(Object.isFrozen(c.disable)).to.equal(true);
  });

  it('does not freeze or share the configuration objects', () => {
    const cfg = { authz: { fields: { neverRead: ['A'] } } };
    const c = readDomainConfig(getter(cfg), ['root']);
    expect(Object.isFrozen(cfg.authz.fields.neverRead)).to.equal(false);
    expect(c.fields.neverRead).to.not.equal(cfg.authz.fields.neverRead);
  });
});

describe('legacy keys', () => {
  const logger = () => {
    const warnings: string[] = [];
    return { warnings, log: { warn: (m: string) => void warnings.push(m) } };
  };

  it('lists the authorization rows', () => {
    const rows = Object.fromEntries(AUTHZ_LEGACY_KEYS.map((r) => [r.from, r.to]));
    expect(rows['rbac.grants']).to.equal('authz.rbac.roles');
    expect(rows['rbac.roles']).to.equal('authz.rbac.roles');
    expect(rows['rbac.defaultRole']).to.equal('authz.rbac.defaultRoles');
    expect(rows['rbac.enableGuestAccount']).to.equal('authz.principals.anonymous.enabled');
    expect(rows['rbac.requireKnownRole']).to.equal(null);
    expect(rows['rbac.systemRole']).to.equal(null);
    expect(rows['rbac.roleColumn']).to.equal(null);
    expect(rows['rbac.roleSwitch']).to.equal('authz.principals.roleSwitch');
    expect(rows['rbac.impersonation.protectedRoles']).to.equal('authz.impersonation.protectedRoles');
    expect(rows['rbac.admin.roleGuard']).to.equal('authz.admin.guard');
    expect(rows['rbac.token.rolePolicy']).to.equal('authz.token.rolePolicy');
    expect(rows['rbac.token.excludedRoles']).to.equal('authz.token.excludedRoles');
  });

  it('finds one finding per leaf with the longest matching row', () => {
    const found = findLegacyKeys({ grants: { admin: { x: 1 } }, defaultRole: ['a', 'b'], session: { cookie: 'c' }, roleColumn: 'r', impersonation: { protectedRoles: ['x'], other: 1 } });
    const byPath = Object.fromEntries(found.map((f) => [f.path, f.to]));
    expect(byPath).to.deep.equal({
      'rbac.grants.admin.x': 'authz.rbac.roles',
      'rbac.defaultRole': 'authz.rbac.defaultRoles',
      'rbac.session.cookie': 'authn.* or users.*',
      'rbac.roleColumn': null,
      'rbac.impersonation.protectedRoles': 'authz.impersonation.protectedRoles',
      'rbac.impersonation.other': 'authn.* or users.*',
    });
  });

  it('treats a non-object rbac as one leaf', () => {
    expect(findLegacyKeys(true).map((f) => f.path)).to.deep.equal(['rbac']);
  });

  it('does nothing without rbac', () => {
    const { warnings, log } = logger();
    checkLegacyKeys(getter({ authz: { config: { rejectLegacyKeys: true } } }), log);
    expect(warnings).to.deep.equal([]);
  });

  it('warns once when rejectLegacyKeys is not set', () => {
    const { warnings, log } = logger();
    checkLegacyKeys(getter({ rbac: { grants: { admin: { a: 1 } }, session: { cookie: 'c' } } }), log);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.contain('rbac.grants.admin.a');
    expect(warnings[0]).to.contain('authz.rbac.roles');
    expect(warnings[0]).to.contain('authn.* or users.*');
  });

  it('throws one error listing every key when rejectLegacyKeys is true', () => {
    const { warnings, log } = logger();
    let err: unknown;
    try {
      checkLegacyKeys(getter({ rbac: { grants: { admin: { a: 1 } }, session: { cookie: 'c' } }, authz: { config: { rejectLegacyKeys: true } } }), log);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    const m = (err as Error).message;
    expect(m).to.contain('rbac.grants.admin.a');
    expect(m).to.contain('rbac.session.cookie');
    expect(m).to.contain('spinajs-authz-convert');
    expect(warnings).to.deep.equal([]);
  });

  it('does not throw when rejectLegacyKeys is false', () => {
    const { warnings, log } = logger();
    checkLegacyKeys(getter({ rbac: { roles: {} }, authz: { config: { rejectLegacyKeys: false } } }), log);
    expect(warnings).to.have.length(1);
  });

  it('maps rbac.user, rbac.email and rbac.actions to users.*', () => {
    const byPath = Object.fromEntries(findLegacyKeys({ user: { a: 1 }, email: 'x', actions: { b: 1 } }).map((f) => [f.path, f.to]));
    expect(byPath).to.deep.equal({ 'rbac.user.a': 'users.user', 'rbac.email': 'users.email', 'rbac.actions.b': 'users.actions' });
  });

  it('throws when authz.config is not an object', () => {
    for (const bad of ['x', 5, null, []]) {
      const { log } = logger();
      expect(() => checkLegacyKeys(getter({ rbac: { roles: {} }, authz: { config: bad } }), log), String(bad)).to.throw(AuthzConfigError, 'authz.config');
    }
  });

  it('includes the notes of the rows in the text', () => {
    const { warnings, log } = logger();
    checkLegacyKeys(getter({ rbac: { defaultRole: 'x', password: { lockoutTime: 5 }, roleColumn: 'r' } }), log);
    expect(warnings[0]).to.contain('authz.rbac.anonymousRoles');
    expect(warnings[0]).to.contain('rbac.password.lockoutTime -> removed (H31:');
    expect(warnings[0]).to.contain('authn.throttle.login.account.maxDelayMs');
    expect(warnings[0]).to.contain('rbac.roleColumn -> removed');
  });

  it('throws when rejectLegacyKeys is not a boolean', () => {
    for (const bad of ['true', 1]) {
      const { warnings, log } = logger();
      expect(() => checkLegacyKeys(getter({ rbac: { roles: {} }, authz: { config: { rejectLegacyKeys: bad } } }), log)).to.throw(AuthzConfigError, 'rejectLegacyKeys');
      expect(warnings).to.deep.equal([]);
    }
  });
});

describe('AuthzConfigBootstrapper', () => {
  it('registers the schema under __configurationSchema__', () => {
    const before = [...((DI.get(Array.ofType('__configurationSchema__' as any)) as unknown[] | null) ?? [])];
    const schemas = () => (DI.get(Array.ofType('__configurationSchema__' as any)) as unknown[] | null) ?? [];
    expect(schemas()).to.not.include(AUTHZ_CONFIGURATION_SCHEMA);
    new AuthzConfigBootstrapper().bootstrap();
    try {
      expect(schemas()).to.include(AUTHZ_CONFIGURATION_SCHEMA);
    } finally {
      // DI cannot drop one cached value: drop the key and put back what was there before.
      DI.uncache('__configurationSchema__');
      for (const other of before) DI.register(other as any).asValue('__configurationSchema__');
    }
    expect(schemas()).to.not.include(AUTHZ_CONFIGURATION_SCHEMA);
    expect(schemas()).to.have.length(before.length);
  });
});
