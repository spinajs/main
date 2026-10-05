import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { AuthzConfigError, FALSE, PermissionRegistry, TRUE, UnknownPermission, compilePermissionGlob } from '@spinajs/authz';
import type { AdminCallContext, AuthorizationModel, AuthzService, Principal, ResourceRef } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';

import { CheckRbacAdminFacts, RbacModel } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';
import { G, P1, START, StaticRoleStore, installHost, instance, permissionRegistry, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
const grants = (...names: string[]) => names.map((permission) => ({ permission }));

const ROLES: RoleDef[] = [role('viewer', { ladder: 'project', grants: grants('file:read') }), role('editor', { ladder: 'project', grants: [{ permission: 'file:edit', relation: 'owner' }] }), role('maintainer', { ladder: 'project', grants: grants('project:settings') }), role('empty'), role('globber', { grants: grants('file:*') }), role('broken', { extends: ['ghost'] }), role('reader', { extends: ['viewer'] }), role('userAdmin', { grants: grants('users:update') }), role('lead', { implies: [{ role: 'maintainer', at: 'self-and-descendants' }] }), role('below', { implies: [{ role: 'viewer', at: 'descendants' }] }), role('skip', { implies: [{ role: 'viewer', at: 'self-and-descendants', bypass: ['cap'] }] }), role('haunted', { implies: [{ role: 'ghost', at: 'descendants' }] }), role('gview', { ladder: 'glob', grants: grants('file:*') })];
const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'] },
  { name: 'bare', roles: ['empty'] },
  { name: 'glob', roles: ['gview'] },
];

/** alice: file:read and file:edit unconditionally, project:settings only conditionally, rank editor (and gview); anyone else nothing. */
function model(): StaticModel {
  return new StaticModel({
    name: 'facts',
    votes: (req): ScriptedVote => {
      if (req.principal.id !== 'alice') return {};
      const roles = { project: 'editor', glob: 'gview' };
      if (['file:read', 'file:edit', 'file:delete', 'users:update'].some((g) => compilePermissionGlob(g)(req.permission))) return { permitWhen: TRUE, roles };
      if (req.permission === 'project:settings') return { permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' }, roles };
      return { permitWhen: FALSE, roles };
    },
  });
}

describe('CheckRbacAdminFacts', function () {
  this.timeout(20000);
  let d: RbacDomain;
  const facts = new CheckRbacAdminFacts();
  const alice = userPrincipal('alice');
  const bob = userPrincipal('bob');

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    d = await rbacDomain('test', { roleStores: [new StaticRoleStore('facts', ROLES, LADDERS)], model: model(), permissions: { 'users:update': {} } });
  });

  const ctx = (actor: Principal = alice): AdminCallContext => ({ domain: 'test', now: START, authz: d.service, actor, container: d.container, dryRun: false });
  const covers = (r: string, at: ResourceRef = P1, actor: Principal = alice) => facts.covers(actor, r, at, ctx(actor));

  it('covers a role when every literal permission of its closure is allowed unconditionally', async () => {
    expect(await covers('viewer')).to.equal(true);
    expect(await covers('reader')).to.equal(true);
    expect(await covers('editor')).to.equal(true);
    expect(await covers('viewer', P1, bob)).to.equal(false);
  });

  it('a conditional allow does not cover', async () => {
    expect(await covers('maintainer')).to.equal(false);
  });

  it('a role that grants nothing is covered', async () => {
    expect(await covers('empty', P1, bob)).to.equal(true);
  });

  it('fails closed: a glob grant with no registry, an undefined role in the closure, a check that throws', async () => {
    expect(await covers('globber')).to.equal(false);
    expect(await covers('broken')).to.equal(false);
    expect(await covers('ghost')).to.equal(false);
    // users:update is not checkable on a project.
    expect(await covers('userAdmin', P1)).to.equal(false);
    expect(await covers('userAdmin', G)).to.equal(true);
  });

  it('covers follows implied roles of both kinds and checks them at the scope', async () => {
    expect(await covers('below')).to.equal(true);
    expect(await covers('below', P1, bob)).to.equal(false);
    // lead implies maintainer, whose project:settings alice holds only conditionally.
    expect(await covers('lead')).to.equal(false);
  });

  it('fails closed on an implied role that bypasses rules or is undefined', async () => {
    expect(await covers('skip')).to.equal(false);
    expect(await covers('haunted')).to.equal(false);
  });

  it('only a configuration error of a check counts as not covered; any other rejects', async () => {
    const throwing = (e: Error): AdminCallContext => {
      const authz = Object.create(d.service) as typeof d.service;
      Object.assign(authz, {
        checkMany: async () => {
          throw e;
        },
        check: async () => {
          throw e;
        },
      });
      return { ...ctx(), authz };
    };
    const down = new Error('driver down');
    expect(await rejection(facts.covers(alice, 'viewer', P1, throwing(down)))).to.equal(down);
    expect(await rejection(facts.effectiveRole(alice, 'project', P1, throwing(down)))).to.equal(down);
    expect(await facts.covers(alice, 'viewer', P1, throwing(new AuthzConfigError('not checkable here')))).to.equal(false);
    expect(await facts.covers(alice, 'viewer', P1, throwing(new UnknownPermission('file:read')))).to.equal(false);
    expect(await facts.effectiveRole(alice, 'project', P1, throwing(new AuthzConfigError('not checkable here')))).to.equal(undefined);
  });

  it('effectiveRole reads Decision.roles of a check at the scope, denials included', async () => {
    expect(await facts.effectiveRole(alice, 'project', P1, ctx())).to.equal('editor');
    expect(await facts.effectiveRole(bob, 'project', P1, ctx(bob))).to.equal(undefined);
  });

  it('effectiveRole is undefined for an unknown ladder, a ladder without a permission, and a glob with no registry', async () => {
    expect(await facts.effectiveRole(alice, 'ghost', P1, ctx())).to.equal(undefined);
    expect(await facts.effectiveRole(alice, 'bare', P1, ctx())).to.equal(undefined);
    expect(await facts.effectiveRole(alice, 'glob', P1, ctx())).to.equal(undefined);
  });
});

describe('CheckRbacAdminFacts with a permission registry', function () {
  this.timeout(20000);
  let d: RbacDomain;
  const facts = new CheckRbacAdminFacts();
  const alice = userPrincipal('alice');
  // file:* also matches file:purge here, which alice lacks.
  const PURGE = { 'users:update': {}, 'file:purge': { types: ['project'] } };
  const plain = () => permissionRegistry({ 'users:update': {} });
  const wide = () => permissionRegistry(PURGE);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  const domain = async (register?: (c: IContainer) => void) => {
    await resetHost();
    d = await rbacDomain('test', { roleStores: [new StaticRoleStore('facts', ROLES, LADDERS)], model: model(), permissions: PURGE, register });
  };
  const inContainer = (registry: unknown) => (c: IContainer) => c.register(instance(registry)).as(PermissionRegistry);
  const withModels = (models: readonly object[]): AuthzService =>
    new Proxy(d.service, {
      get: (t, k) => {
        if (k === 'models') return () => models;
        const v: unknown = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  const ctx = (models?: readonly object[]): AdminCallContext => ({ domain: 'test', now: START, authz: models === undefined ? d.service : withModels(models), actor: alice, container: d.container, dryRun: false });
  const covers = (r: string, models?: readonly object[]) => facts.covers(alice, r, P1, ctx(models));
  const exposing = (registry: unknown) => ({ name: 'decoy', permissions: () => registry });
  const rbacExposing = (registry: PermissionRegistry): AuthorizationModel => Object.assign(Object.create(RbacModel.prototype) as RbacModel, { permissions: () => registry });

  it('a glob grant asks for every registered permission it matches', async () => {
    await domain(inContainer(plain()));
    expect(await covers('globber')).to.equal(true);
    await domain(inContainer(wide()));
    expect(await covers('globber')).to.equal(false);
  });

  it("an RbacModel's registry comes first, then another model's, then the container's", async () => {
    await domain(inContainer(wide()));
    expect(await covers('globber')).to.equal(false);
    expect(await covers('globber', [exposing(plain())])).to.equal(true);
    expect(await covers('globber', [exposing(wide()), rbacExposing(plain())])).to.equal(true);
    expect(await covers('globber', [exposing(plain()), rbacExposing(wide())])).to.equal(false);
  });

  it('a model whose permissions() is not a registry is skipped, and so is a container entry that is not one', async () => {
    await domain(inContainer(plain()));
    expect(await covers('globber', [exposing(['file:purge']), exposing(undefined)])).to.equal(true);
    // Shaped like a registry whose file:* matches only file:read, which alice holds.
    const shaped = { get: () => undefined, require: () => undefined, match: () => [{ name: 'file:read', implies: [] }], impliedBy: () => [], all: () => [] };
    await domain(inContainer(shaped));
    expect(await covers('globber')).to.equal(false);
  });

  it('effectiveRole probes the registered permissions a glob grant matches', async () => {
    await domain(inContainer(plain()));
    expect(await facts.effectiveRole(alice, 'glob', P1, ctx())).to.equal('gview');
  });
});

describe('CheckRbacAdminFacts field sets', function () {
  this.timeout(20000);
  let d: RbacDomain;
  const facts = new CheckRbacAdminFacts();
  const carol = userPrincipal('carol');
  const dave = userPrincipal('dave');
  const FIELD_ROLES: RoleDef[] = [role('globDoc', { grants: grants('doc:*') }), role('nameGlobDoc', { grants: [{ permission: 'doc:*', fields: { read: ['name'] } }] }), role('fullDoc', { grants: grants('doc:read') }), role('nameDoc', { grants: [{ permission: 'doc:read', fields: { read: ['name'] } }] }), role('bodyDoc', { grants: [{ permission: 'doc:read', fields: { read: ['name', 'body'] } }] }), role('hideDoc', { grants: [{ permission: 'doc:read', fields: { hide: ['secret'] } }] })];

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    // carol reads only the name of a doc; dave reads every field.
    const fieldModel = new StaticModel({
      name: 'fields',
      capabilities: { fields: true },
      votes: (req): ScriptedVote => {
        if (req.permission !== 'doc:read') return {};
        if (req.principal.id === 'carol') return { permitWhen: TRUE, fields: { read: ['name'] } };
        if (req.principal.id === 'dave') return { permitWhen: TRUE };
        return {};
      },
    });
    const permissions = { 'doc:read': { types: ['project'], fields: true } as { types: string[] } };
    d = await rbacDomain('test', { roleStores: [new StaticRoleStore('fields', FIELD_ROLES, [])], model: fieldModel, permissions, register: (c) => c.register(instance(permissionRegistry(permissions))).as(PermissionRegistry) });
  });

  const ctx = (actor: Principal): AdminCallContext => ({ domain: 'test', now: START, authz: d.service, actor, container: d.container, dryRun: false });

  it('an actor limited to some fields covers a role limited to those fields only', async () => {
    expect(await facts.covers(carol, 'nameDoc', P1, ctx(carol))).to.equal(true);
    expect(await facts.covers(carol, 'bodyDoc', P1, ctx(carol))).to.equal(false);
    expect(await facts.covers(carol, 'fullDoc', P1, ctx(carol))).to.equal(false);
    // A field set with hide only gives every other field.
    expect(await facts.covers(carol, 'hideDoc', P1, ctx(carol))).to.equal(false);
  });

  it('a glob grant carries its field set to each permission it matches', async () => {
    expect(await facts.covers(carol, 'nameGlobDoc', P1, ctx(carol))).to.equal(true);
    expect(await facts.covers(carol, 'globDoc', P1, ctx(carol))).to.equal(false);
  });

  it('an actor with every field covers each of them', async () => {
    for (const r of ['nameDoc', 'bodyDoc', 'fullDoc', 'hideDoc', 'globDoc', 'nameGlobDoc']) expect(await facts.covers(dave, r, P1, ctx(dave)), r).to.equal(true);
  });
});
