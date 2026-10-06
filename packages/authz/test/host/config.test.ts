import * as chai from 'chai';
import 'mocha';
import Ajv from 'ajv';
import ajvFormats from 'ajv-formats';
import ajvKeywords from 'ajv-keywords';

import { AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_DEFAULTS, readDomainConfig, configAt, AUTHZ_LEGACY_KEYS, checkLegacyKeys, findLegacyKeys, AuthzConfigError, AuthzConfigBootstrapper } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { childWith, violationsOf } from './support.js';

const expect = chai.expect;

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
  admin: {
    maxBatch: 50,
    backend: 'DbAuthzAdminBackend',
    connection: 'authz',
    permissions: { 'assignment.*': 'app:members.manage', 'assignment.grant': { project: 'app:project.share', '*': 'app:any.share' } },
    guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: false },
  },
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

  it('fills the root-level defaults from AUTHZ_DEFAULTS, and none inside a domain', () => {
    const cfg: any = { domains: { fs: { engine: {} } } };
    expect(validate(cfg).ok).to.equal(true);
    expect(cfg).to.deep.include({
      combine: AUTHZ_DEFAULTS.combine,
      engine: AUTHZ_DEFAULTS.engine,
      fields: AUTHZ_DEFAULTS.fields,
      cache: AUTHZ_DEFAULTS.cache,
      audit: AUTHZ_DEFAULTS.audit,
      config: AUTHZ_DEFAULTS.config,
    });
    expect(cfg.principals ?? {}).to.not.have.nested.property('anonymous.enabled');
    expect(cfg.domains).to.deep.equal({ fs: { engine: {} } });
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
    fails({ domains: { fs: { parent: 'a b' } } }, '/domains/fs/parent', 'pattern');
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
  it('returns the defaults without an authz tree', () => {
    const c = readDomainConfig(undefined, ['root']);
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
    const c = readDomainConfig(validConfig(), ['root']);
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
    const c = readDomainConfig(validConfig(), ['root', 'fs']);
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
    const authz = { engine: { maxDelegation: 5 }, domains: { a: { engine: { modelTimeoutMs: 10 } }, b: { parent: 'a', engine: { explain: true } } } };
    const c = readDomainConfig(authz, ['root', 'a', 'b']);
    expect(c.engine).to.deep.equal({ explain: true, modelTimeoutMs: 10, maxDelegation: 5 });
    expect(c.parent).to.equal('a');
  });

  it('takes combine from the nearest level, whole', () => {
    const authz = { combine: { default: { algorithm: 'permit-overrides' }, types: { T: { algorithm: 'x' } } }, domains: { a: { combine: { default: { algorithm: 'first-applicable' } } }, b: { parent: 'a' }, c: {} } };
    expect(readDomainConfig(authz, ['root', 'a', 'b']).combine).to.deep.equal({ default: { algorithm: 'first-applicable' } });
    expect(readDomainConfig(authz, ['root', 'c']).combine.default.algorithm).to.equal('permit-overrides');
    expect(readDomainConfig(authz, ['root']).combine.types!.T.algorithm).to.equal('x');
  });

  it('reads disable and permissions for this level only', () => {
    const authz = { permissions: { 'r.p': {} }, domains: { a: { disable: ['m'], permissions: { 'a.p': { description: 'd' } } }, b: {} } };
    const a = readDomainConfig(authz, ['root', 'a']);
    expect(a.disable).to.deep.equal(['m']);
    expect(Object.keys(a.permissions)).to.deep.equal(['a.p']);
    const b = readDomainConfig(authz, ['root', 'a', 'b']);
    expect(b.disable).to.deep.equal([]);
    expect(b.permissions).to.deep.equal({});
    expect(Object.keys(readDomainConfig(authz, ['root']).permissions)).to.deep.equal(['r.p']);
  });

  it('reads domains whose name contains a dot', () => {
    expect(readDomainConfig({ domains: { 'a.b': { engine: { explain: true } } } }, ['root', 'a.b']).engine.explain).to.equal(true);
  });

  it('only merges: the schema checks the types, and a level that is not an object is skipped', () => {
    expect(readDomainConfig('x', ['root']).engine).to.deep.equal(AUTHZ_DEFAULTS.engine);
    expect(readDomainConfig({ domains: { fs: 5 } }, ['root', 'fs']).cache).to.deep.equal(AUTHZ_DEFAULTS.cache);
    expect(readDomainConfig({ engine: { modelTimeoutMs: 'x' } }, ['root']).engine.modelTimeoutMs).to.equal('x');
  });

  it('reads domains named like Object.prototype members', () => {
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const domains = JSON.parse(`{"${name}":{"engine":{"modelTimeoutMs":7}}}`);
      expect(readDomainConfig({ domains }, ['root', name]).engine.modelTimeoutMs, name).to.equal(7);
      expect(readDomainConfig({}, ['root', name]).engine.modelTimeoutMs, name).to.equal(2000);
    }
  });

  it('does not resolve a prototype-named domain absent from a non-empty domains map', () => {
    const authz = { domains: { other: { engine: { modelTimeoutMs: 7 } } } };
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const c = readDomainConfig(authz, ['root', name]);
      expect(c.engine.modelTimeoutMs, name).to.equal(2000);
      expect(c.parent, name).to.equal(undefined);
      expect(c.disable, name).to.deep.equal([]);
    }
  });

  it('ignores bus and principals set at domain level', () => {
    const authz = { domains: { fs: { bus: { service: 'X' }, principals: { anonymous: { enabled: false } } } } };
    const c = readDomainConfig(authz, ['root', 'fs']);
    expect(c.bus).to.deep.equal({});
    expect(c.principals).to.deep.equal({ anonymousEnabled: true });
  });

  it('returns a deeply frozen result', () => {
    const c = readDomainConfig(validConfig(), ['root', 'fs']);
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
    const authz = { fields: { neverRead: ['A'] } };
    const c = readDomainConfig(authz, ['root']);
    expect(Object.isFrozen(authz.fields.neverRead)).to.equal(false);
    expect(c.fields.neverRead).to.not.equal(authz.fields.neverRead);
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
    checkLegacyKeys(undefined, true, log);
    expect(warnings).to.deep.equal([]);
  });

  it('warns once when rejectLegacyKeys is off', () => {
    const { warnings, log } = logger();
    checkLegacyKeys({ grants: { admin: { a: 1 } }, session: { cookie: 'c' } }, false, log);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.contain('rbac.grants.admin.a');
    expect(warnings[0]).to.contain('authz.rbac.roles');
    expect(warnings[0]).to.contain('authn.* or users.*');
  });

  it('throws one error listing every key when rejectLegacyKeys is on', () => {
    const { warnings, log } = logger();
    let err: unknown;
    try {
      checkLegacyKeys({ grants: { admin: { a: 1 } }, session: { cookie: 'c' } }, true, log);
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

  it('maps rbac.user, rbac.email and rbac.actions to users.*', () => {
    const byPath = Object.fromEntries(findLegacyKeys({ user: { a: 1 }, email: 'x', actions: { b: 1 } }).map((f) => [f.path, f.to]));
    expect(byPath).to.deep.equal({ 'rbac.user.a': 'users.user', 'rbac.email': 'users.email', 'rbac.actions.b': 'users.actions' });
  });

  it('includes the notes of the rows in the text', () => {
    const { warnings, log } = logger();
    checkLegacyKeys({ defaultRole: 'x', password: { lockoutTime: 5 }, roleColumn: 'r' }, false, log);
    expect(warnings[0]).to.contain('authz.rbac.anonymousRoles');
    expect(warnings[0]).to.contain('rbac.password.lockoutTime -> removed (H31:');
    expect(warnings[0]).to.contain('authn.throttle.login.account.maxDelayMs');
    expect(warnings[0]).to.contain('rbac.roleColumn -> removed');
  });
});

describe('authz configuration through a child Configuration', function () {
  this.timeout(30000);
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function booted(values: Record<string, unknown>) {
    const { child, configuration } = await childWith(values);
    children.push(child);
    return configuration;
  }

  it('validates the values of the child with the authz schema, naming every full path', async () => {
    expect(await violationsOf({ authz: { engine: { modelTimeoutMs: 0 }, domains: { 'a.b': { cache: { ttlSeconds: -1 } } } } })).to.include.members(['authz.engine.modelTimeoutMs', 'authz.domains.a.b.cache.ttlSeconds']);
  });

  it('boots a valid child Configuration with its values', async () => {
    const configuration = await booted({ authz: { engine: { explain: true } } });
    expect(configuration.get(['authz', 'engine', 'explain'])).to.equal(true);
  });

  it('fills the root-level defaults of an unconfigured authz, equal to AUTHZ_DEFAULTS', async () => {
    const authz = (await booted({})).get<Record<string, unknown>>(['authz']);
    expect(authz).to.deep.include({ combine: AUTHZ_DEFAULTS.combine, engine: AUTHZ_DEFAULTS.engine, fields: AUTHZ_DEFAULTS.fields, cache: AUTHZ_DEFAULTS.cache, audit: AUTHZ_DEFAULTS.audit, config: AUTHZ_DEFAULTS.config });
    expect(authz.principals ?? {}).to.not.have.nested.property('anonymous.enabled');
  });

  it('fills only the keys a root section leaves out', async () => {
    const authz = (await booted({ authz: { engine: { maxDelegation: 5 }, fields: { write: { mode: 'reject' } } } })).get<Record<string, unknown>>(['authz']);
    expect(authz.engine).to.deep.equal({ explain: false, modelTimeoutMs: 2000, maxDelegation: 5 });
    expect(authz.fields).to.deep.equal({ neverRead: ['Password'], write: { mode: 'reject' } });
  });

  it('puts no default inside a domain section, so the domain inherits from its parent', async () => {
    const tree = (await booted({ authz: { engine: { maxDelegation: 5 }, domains: { 'a.b': { engine: { modelTimeoutMs: 20 } }, c: { parent: 'a.b' } } } })).get<unknown>(['authz']);
    expect(configAt(tree, ['domains', 'a.b'])).to.deep.equal({ engine: { modelTimeoutMs: 20 } });
    expect(configAt(tree, ['domains', 'c'])).to.deep.equal({ parent: 'a.b' });
    expect(readDomainConfig(tree, ['root', 'a.b', 'c']).engine).to.deep.equal({ explain: false, modelTimeoutMs: 20, maxDelegation: 5 });
  });

  it('refuses a bad value at any level, naming its full path', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ engine: { modelTimeoutMs: 0 } }, 'authz.engine.modelTimeoutMs'],
      [{ engine: 5 }, 'authz.engine'],
      [{ fields: { write: { mode: 'drop' } } }, 'authz.fields.write.mode'],
      [{ fields: { neverRead: 'Password' } }, 'authz.fields.neverRead'],
      [{ audit: { service: '' } }, 'authz.audit.service'],
      [{ bus: { service: '' } }, 'authz.bus.service'],
      [{ principals: { anonymous: { enabled: 'no' } } }, 'authz.principals.anonymous.enabled'],
      [{ config: 5 }, 'authz.config'],
      [{ config: { rejectLegacyKeys: 'sometimes' } }, 'authz.config.rejectLegacyKeys'],
      [{ combine: { default: {} } }, 'authz.combine.default.algorithm'],
      [{ domains: { root: {} } }, 'authz.domains.root'],
      [{ domains: { 'a.b': { engine: { explain: 'yes' } } } }, 'authz.domains.a.b.engine.explain'],
      [{ domains: { fs: { cache: { ttlSeconds: -1 } } } }, 'authz.domains.fs.cache.ttlSeconds'],
      [{ domains: { fs: { disable: 'abac' } } }, 'authz.domains.fs.disable'],
      [{ domains: { fs: { permissions: { 'fs:read': { types: 'File' } } } } }, 'authz.domains.fs.permissions.fs:read.types'],
      [{ domains: { fs: { parent: 'a b' } } }, 'authz.domains.fs.parent'],
      [{ domains: { fs: { parent: {} } } }, 'authz.domains.fs.parent'],
    ];
    for (const [authz, path] of cases) expect(await violationsOf({ authz }), path).to.include(path);
  });
});

describe('authz.admin through a child Configuration', function () {
  this.timeout(30000);
  const children: IContainer[] = [];
  const EXPECTED_ADMIN_DEFAULTS = { maxBatch: 100, backend: 'MemoryAuthzAdminBackend', connection: 'default' };
  const adminSchema = (AUTHZ_CONFIGURATION_SCHEMA.properties.admin as any).properties;

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function admin(values: Record<string, unknown>): Promise<unknown> {
    const { child, configuration } = await childWith(values);
    children.push(child);
    return configuration.get(['authz', 'admin']);
  }

  it('fills maxBatch, backend and permissions from ADMIN_DEFAULTS, and no guard', async () => {
    expect(await admin({})).to.deep.equal({ ...EXPECTED_ADMIN_DEFAULTS, permissions: {} });
    expect(adminSchema.maxBatch.default).to.equal(EXPECTED_ADMIN_DEFAULTS.maxBatch);
    expect(adminSchema.backend.default).to.equal(EXPECTED_ADMIN_DEFAULTS.backend);
  });

  it('turns every switch of a configured guard on', async () => {
    expect(await admin({ authz: { admin: { guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update' } } } })).to.deep.equal({
      ...EXPECTED_ADMIN_DEFAULTS,
      permissions: {},
      guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true },
    });
  });

  it('needs privilegedPermission while a self-lockout or last-holder check is on', async () => {
    expect(await violationsOf({ authz: { admin: { guard: { service: 'X' } } } })).to.include('authz.admin.guard.privilegedPermission');
    expect(await violationsOf({ authz: { admin: { guard: { preventSelfLockout: false } } } })).to.include('authz.admin.guard.privilegedPermission');
    expect(await admin({ authz: { admin: { guard: { service: 'X', preventSelfLockout: false, preventLastPrivilegedRemoval: false } } } })).to.have.nested.property('guard.service', 'X');
  });

  it('keeps a null guard switch null, never false, so a reader treating null as on keeps the guard on', async () => {
    const guard = { privilegedPermission: 'users:update', protectSystemRole: null, preventEscalation: null, preventSelfLockout: null, preventLastPrivilegedRemoval: null };
    expect(await admin({ authz: { admin: { guard } } })).to.have.property('guard').that.deep.include(guard);
  });

  it('refuses a bad value, naming its full path', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ maxBatch: 0 }, 'authz.admin.maxBatch'],
      [{ maxBatch: 1.5 }, 'authz.admin.maxBatch'],
      [{ backend: '' }, 'authz.admin.backend'],
      [{ connection: '' }, 'authz.admin.connection'],
      [{ guard: { service: '', privilegedPermission: 'users:update' } }, 'authz.admin.guard.service'],
      [{ guard: { privilegedPermission: 'users' } }, 'authz.admin.guard.privilegedPermission'],
      [{ guard: { protectSystemRole: 'sometimes', privilegedPermission: 'users:update' } }, 'authz.admin.guard.protectSystemRole'],
      [{ permissions: 'x' }, 'authz.admin.permissions'],
      [{ permissions: { 'assignment.grant': 42 } }, 'authz.admin.permissions.assignment.grant'],
      [{ permissions: { 'assignment.grant': { project: 'not a permission' } } }, 'authz.admin.permissions.assignment.grant'],
    ];
    for (const [value, path] of cases) expect(await violationsOf({ authz: { admin: value } }), path).to.include(path);
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

describe('authz package layout', () => {
  // Configuration loads every module under node_modules/@spinajs/*/lib/{mjs,cjs}/config as a config file.
  it('ships no code modules in lib/*/config', () => {
    for (const flavour of ['mjs', 'cjs']) {
      expect(existsSync(join(process.cwd(), 'lib', flavour, 'config')), `lib/${flavour}/config`).to.eq(false);
    }
  });
});
