import { AuthzConfigError, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, ManualClock, agentPrincipal, anonymousPrincipal, fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacService } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, who: { type: string; id: string }, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: who.type, id: who.id }, role: roleName, scope, source: 'test', ...extra });

const PERMISSIONS: PermissionInput[] = [
  { name: 'doc:read', types: ['file', 'project'] },
  { name: 'doc:write', types: ['file', 'project'] },
  { name: 'doc:delete', types: ['file', 'project'] },
  { name: 'user:read', fields: true },
  { name: 'dir:list', types: ['dir'] },
  { name: 'note:read', types: ['file'] },
];

const ROLES: RoleDef[] = [role('reader', ['doc:read']), role('writer', ['doc:write'], { extends: ['reader'] }), role('all', ['doc:*']), role('ownerWriter', [{ permission: 'doc:write', relation: 'owner' }]), role('eitherWriter', [{ permission: 'doc:write', relation: ['owner', 'editor'] }]), role('names', [{ permission: 'user:read', fields: { read: ['name'] } }]), role('contacts', [{ permission: 'user:read', fields: { read: ['name', 'email'] } }]), role('users', ['user:read']), role('home', [{ permission: 'dir:list', on: [{ type: 'dir', id: 'home/{principal.id}' }] }]), role('home2', [{ permission: 'dir:list', on: [{ type: 'dir', id: 'home/{principal.id}' }] }]), role('tmp', [{ permission: 'dir:list', on: [{ type: 'dir', id: 'tmp' }] }]), role('dirs', ['dir:list']), role('tagged', [{ permission: 'doc:delete', requiresTag: 'danger' }]), role('deleter', ['doc:delete']), role('typedReader', [{ permission: 'doc:read', on: [{ type: 'file' }] }]), role('noteTyped', [{ permission: 'note:read', on: [{ type: 'file' }] }]), role('globReader', [{ permission: 'doc:read', on: [{ type: 'file', id: 'pub/*' }] }]), role('noteReader', ['note:read']), role('writerOnly', ['doc:write'])];

async function setup(assignments: readonly Assignment[] = [], config: Record<string, unknown> = {}) {
  const registry = new PermissionRegistryImpl();
  registry.register(PERMISSIONS, 'test');
  registry.freeze();
  const clock = new ManualClock(NOW);
  const model = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(assignments), clock, log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', config, permissions: registry }));
  model.grantIndex();
  return { model, clock, service: new RbacService(model) };
}

const scopes = new FakeScopeResolver({
  types: ['org', 'project', 'file'],
  nodes: [{ ref: O1 }, { ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: f1, parent: P1 }],
});
const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });
const roleNames = (list: readonly { role: string }[]) => list.map((r) => r.role).sort();

describe('authz-rbac model: RbacService', () => {
  describe('grantsOf', () => {
    it("gives the compiled grants of the role's closure with permissions expanded", async () => {
      const { service } = await setup();
      expect(service.grantsOf('writer').map((g) => [g.permission, g.role])).to.deep.equal([
        ['doc:read', 'reader'],
        ['doc:write', 'writer'],
      ]);
      expect(service.grantsOf('all').map((g) => g.permission)).to.deep.equal(['doc:delete', 'doc:read', 'doc:write']);
      expect(Object.isFrozen(service.grantsOf('all'))).to.equal(true);
    });

    it('gives nothing for an unknown role', async () => {
      const { service } = await setup();
      expect(service.grantsOf('ghost')).to.deep.equal([]);
    });
  });

  describe('covers (role names)', () => {
    const cases: [string, readonly string[], readonly string[], boolean][] = [
      ['a superset covers', ['all'], ['writer'], true],
      ['an equal set covers (not strict: the AdminGuard may hand out its own role)', ['writer'], ['writer'], true],
      ['extends counts: writer holds reader', ['writer'], ['reader'], true],
      ['a missing permission is refused', ['reader'], ['writer'], false],
      ['an unconditional grant covers a conditional one', ['writer'], ['ownerWriter'], true],
      ['a conditional grant does not cover an unconditional one', ['reader', 'ownerWriter'], ['writer'], false],
      ['the same relation covers', ['ownerWriter'], ['ownerWriter'], true],
      ['more relations (an OR) cover fewer', ['eitherWriter'], ['ownerWriter'], true],
      ['fewer relations do not cover more', ['ownerWriter'], ['eitherWriter'], false],
      ['a field superset covers', ['contacts'], ['names'], true],
      ['a field subset is refused', ['names'], ['contacts'], false],
      ['a grant without fields covers every field set', ['users'], ['contacts'], true],
      ['fields do not cover all fields', ['contacts'], ['users'], false],
      ['the same pattern covers', ['home2'], ['home'], true],
      ['another pattern does not', ['tmp'], ['home'], false],
      ['no pattern covers any pattern', ['dirs'], ['home'], true],
      ['a pattern does not cover no pattern', ['home'], ['dirs'], false],
      ['a tag requirement does not cover a grant without one', ['tagged'], ['deleter'], false],
      ['a grant without a tag requirement covers one with it', ['deleter'], ['tagged'], true],
      ['an unknown wanted role is refused', ['all'], ['ghost'], false],
      ['unknown holder roles grant nothing', ['ghost'], ['reader'], false],
      ['nothing wanted is covered', [], [], true],
    ];
    for (const [title, holder, wanted, expected] of cases) {
      it(title, async () => {
        const { service } = await setup();
        expect(service.covers(holder, wanted)).to.equal(expected);
      });
    }
  });

  describe('covers (a principal)', () => {
    it('throws when the principal was not preloaded, never guesses', async () => {
      const { service } = await setup([assignment('a1', alice, 'all')]);
      expect(() => service.covers(alice, ['reader'])).to.throw(AuthzConfigError, 'preload');
    });

    it('reads the preloaded assignments at GLOBAL and at `at` itself, live at the model clock, after the ceiling', async () => {
      const { model, service, clock } = await setup([assignment('a1', alice, 'reader'), assignment('a2', alice, 'all', P1), assignment('a3', alice, 'writer', GLOBAL, { expiresAt: new Date(NOW.getTime() + HOUR) })], { cache: { assignmentsTtlSeconds: 7200 } });
      await model.preload(alice, ctx());
      expect(service.covers(alice, ['writer'])).to.equal(true);
      expect(service.covers(alice, ['deleter'])).to.equal(false);
      expect(service.covers(alice, ['deleter'], P1)).to.equal(true);
      // An assignment at an ancestor of `at` is not read here: covers stays synchronous (see rolesOf).
      expect(service.covers(alice, ['deleter'], f1)).to.equal(false);
      clock.advance(HOUR);
      expect(service.covers(alice, ['writer'])).to.equal(false);
      const narrowed = withCeiling(alice, { roles: ['reader'] });
      await model.preload(narrowed, ctx());
      expect(service.covers(narrowed, ['deleter'], P1)).to.equal(false);
    });

    it('throws while the roles are stale', async () => {
      const { model, service } = await setup([assignment('a1', alice, 'all')]);
      await model.preload(alice, ctx());
      model.invalidate(['role:all']);
      expect(() => service.covers(alice, ['reader'])).to.throw(AuthzConfigError, 'stale');
    });
  });

  describe('rolesOf', () => {
    const held = [assignment('g1', alice, 'reader'), assignment('o1', alice, 'writer', O1, { expiresAt: new Date(NOW.getTime() + HOUR) }), assignment('p2', alice, 'all', P2), assignment('b1', bob, 'all')];

    it('gives the roles live on the path of `at`, with scope and expiry', async () => {
      const { service } = await setup(held);
      expect(await service.rolesOf(alice)).to.deep.equal([{ role: 'reader', scope: GLOBAL, assignment: 'g1', source: 'test' }]);
      const atFile = await service.rolesOf(alice, f1, { ctx: ctx() });
      expect(roleNames(atFile)).to.deep.equal(['reader', 'writer']);
      expect(atFile.find((r) => r.role === 'writer')).to.deep.equal({ role: 'writer', scope: O1, assignment: 'o1', source: 'test', expiresAt: new Date(NOW.getTime() + HOUR) });
    });

    it('applies the ceiling unless asked for the assigned roles (a role switch must see them)', async () => {
      const { service } = await setup(held);
      const narrowed = withCeiling(alice, { roles: ['writer'] });
      expect(roleNames(await service.rolesOf(narrowed, f1, { ctx: ctx() }))).to.deep.equal(['writer']);
      expect(roleNames(await service.rolesOf(narrowed, f1, { ctx: ctx(), ceiling: false }))).to.deep.equal(['reader', 'writer']);
    });

    it('includes config roles', async () => {
      const { service } = await setup([], { anonymousRoles: ['reader'] });
      expect(await service.rolesOf(anonymousPrincipal())).to.deep.equal([{ role: 'reader', scope: GLOBAL, assignment: 'config:anonymousRoles:reader', source: 'config:anonymousRoles' }]);
    });

    it('a concrete `at` without a context needs an ancestors source', async () => {
      const { model } = await setup(held);
      const err = await new RbacService(model).rolesOf(alice, f1).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).to.be.instanceOf(AuthzConfigError);
      const wired = new RbacService(model, { ancestors: (ref) => ctx().ancestors(ref) });
      expect(roleNames(await wired.rolesOf(alice, f1))).to.deep.equal(['reader', 'writer']);
    });
  });

  describe('RbacModel.summarize', () => {
    it('lists the roles live at `at` and the permissions they give, with conditional and fields', async () => {
      const { model } = await setup([assignment('a1', alice, 'writer', GLOBAL, { expiresAt: new Date(NOW.getTime() + HOUR) }), assignment('a2', alice, 'ownerWriter'), assignment('a4', alice, 'contacts')]);
      const summary = await model.summarize(alice, GLOBAL, ctx());
      expect(summary.model).to.equal('rbac');
      expect(summary.roles).to.deep.include({ role: 'writer', scope: GLOBAL, expiresAt: new Date(NOW.getTime() + HOUR).toISOString() });
      expect(summary.roles).to.deep.include({ role: 'ownerWriter', scope: GLOBAL });
      expect(summary.permissions).to.deep.equal([
        { name: 'doc:read', conditional: false },
        { name: 'doc:write', conditional: false },
        { name: 'user:read', conditional: false, fields: { read: ['email', 'name'], write: ['*'] } },
      ]);
    });

    it('a permission only a relation grant gives is conditional', async () => {
      const { model } = await setup([assignment('a1', alice, 'ownerWriter')]);
      expect((await model.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'doc:write', conditional: true }]);
    });

    it('at a resource, assignments on its path count and those elsewhere do not', async () => {
      const { model } = await setup([assignment('a1', alice, 'reader', O1), assignment('a2', alice, 'deleter', P2)]);
      const summary = await model.summarize(alice, f1, ctx());
      expect(summary.roles).to.deep.equal([{ role: 'reader', scope: O1 }]);
      expect(summary.permissions).to.deep.equal([{ name: 'doc:read', conditional: false }]);
    });

    it('at GLOBAL a scoped assignment gives its permissions as conditional, without listing its role', async () => {
      const { model } = await setup([assignment('a1', alice, 'reader', P1)]);
      const summary = await model.summarize(alice, GLOBAL, ctx());
      expect(summary.roles).to.deep.equal([]);
      expect(summary.permissions).to.deep.equal([{ name: 'doc:read', conditional: true }]);
    });

    it('applies the ceiling, as the votes do', async () => {
      const { model } = await setup([assignment('a1', alice, 'reader'), assignment('a2', alice, 'deleter')]);
      const summary = await model.summarize(withCeiling(alice, { roles: ['reader'] }), GLOBAL, ctx());
      expect(summary.roles).to.deep.equal([{ role: 'reader', scope: GLOBAL }]);
      expect(summary.permissions.map((p) => p.name)).to.deep.equal(['doc:read']);
    });

    describe('at $global, per type of each permission', () => {
      const entry = async (roleName: string, scope: ResourceRef = GLOBAL) => {
        const { model } = await setup([assignment('a1', alice, roleName, scope)]);
        return (await model.summarize(alice, GLOBAL, ctx())).permissions;
      };

      it('a type-only pattern is listed: unconditional when it names the permission’s only type, else conditional', async () => {
        expect(await entry('noteTyped')).to.deep.equal([{ name: 'note:read', conditional: false }]);
        expect(await entry('typedReader')).to.deep.equal([{ name: 'doc:read', conditional: true }]);
      });

      it('a glob pattern is listed as conditional', async () => {
        expect(await entry('globReader')).to.deep.equal([{ name: 'doc:read', conditional: true }]);
      });

      it('an assignment at a bare type ref is listed, without its role', async () => {
        const { model } = await setup([assignment('a1', alice, 'noteReader', { type: 'file' })]);
        const summary = await model.summarize(alice, GLOBAL, ctx());
        expect(summary.permissions).to.deep.equal([{ name: 'note:read', conditional: false }]);
        expect(summary.roles).to.deep.equal([]);
      });

      it('a relation grant stays conditional', async () => {
        expect(await entry('ownerWriter')).to.deep.equal([{ name: 'doc:write', conditional: true }]);
      });

      it('fields are the union over the types that permit', async () => {
        const { model } = await setup([assignment('a1', alice, 'contacts')]);
        expect((await model.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'user:read', conditional: false, fields: { read: ['email', 'name'], write: ['*'] } }]);
      });

      it('B26-style subset: a caller without doc:read does not cover a target with a typed doc:read grant', async () => {
        const { model } = await setup([assignment('c1', userPrincipal('caller'), 'writerOnly'), assignment('t1', userPrincipal('target'), 'typedReader'), assignment('r1', userPrincipal('root'), 'all')]);
        const set = async (id: string) => (await model.summarize(userPrincipal(id), GLOBAL, ctx())).permissions;
        // The subset rule of B26 over summary entries: every target entry held by the caller, an unconditional one only unconditionally.
        const covered = async (holder: string, target: string) => {
          const mine = await set(holder);
          return (await set(target)).every((t) => mine.some((h) => h.name === t.name && (!h.conditional || t.conditional)));
        };
        expect(await set('target')).to.deep.equal([{ name: 'doc:read', conditional: true }]);
        expect(await covered('caller', 'target')).to.equal(false);
        expect(await covered('root', 'target')).to.equal(true);
      });
    });
  });

  describe('covers and the ceiling', () => {
    const ttl = { cache: { assignmentsTtlSeconds: 7200 } };

    it('refuses wanted grants outside ceiling.permissions (globs expanded); the role-name overload ignores ceilings', async () => {
      const { model, service } = await setup([assignment('a1', alice, 'all')]);
      const token = withCeiling(alice, { permissions: ['doc:read'] });
      await model.preload(token, ctx());
      expect(service.covers(token, ['reader'])).to.equal(true);
      expect(service.covers(token, ['writer'])).to.equal(false);
      expect(service.covers(withCeiling(alice, { permissions: ['doc:*'] }), ['writer'])).to.equal(true);
      expect(service.covers(withCeiling(alice, { permissions: [] }), ['reader'])).to.equal(false);
      expect(service.covers(['all'], ['writer'])).to.equal(true);
    });

    it('refuses everything wanted past ceiling.expiresAt', async () => {
      const { model, service, clock } = await setup([assignment('a1', alice, 'all')], ttl);
      const token = withCeiling(alice, { expiresAt: new Date(NOW.getTime() + HOUR) });
      await model.preload(token, ctx());
      expect(service.covers(token, ['reader'])).to.equal(true);
      clock.advance(HOUR);
      expect(service.covers(token, ['reader'])).to.equal(false);
    });

    it('ceiling.resources: covers needs `at` (or GLOBAL) listed by key, coversAt reads the path', async () => {
      const { model, service } = await setup([assignment('a1', alice, 'all')]);
      const scoped = withCeiling(alice, { resources: [P1] });
      await model.preload(scoped, ctx());
      expect(service.covers(scoped, ['reader'], P1)).to.equal(true);
      expect(() => service.covers(scoped, ['reader'], f1)).to.throw(AuthzConfigError, 'coversAt');
      expect(await service.coversAt(scoped, ['reader'], f1, ctx())).to.equal(true);
      expect(await service.coversAt(scoped, ['reader'], P2, ctx())).to.equal(false);
      expect(service.covers(withCeiling(alice, { resources: [GLOBAL] }), ['reader'], f1)).to.equal(true);
    });

    it('refuses an agent: the guard must pass the principal the models run with', async () => {
      const { model, service } = await setup([assignment('a1', alice, 'all')]);
      await model.preload(alice, ctx());
      const bot = agentPrincipal('bot', alice);
      expect(() => service.covers(bot, ['reader'])).to.throw(AuthzConfigError, 'on behalf');
      const err = await service.coversAt(bot, ['reader'], P1, ctx()).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).to.be.instanceOf(AuthzConfigError);
    });
  });

  describe('coversAt', () => {
    it('counts assignments at ancestors of `at`, which covers does not read', async () => {
      const { model, service } = await setup([assignment('a1', alice, 'all', O1)]);
      await model.preload(alice, ctx());
      expect(service.covers(alice, ['deleter'], f1)).to.equal(false);
      expect(await service.coversAt(alice, ['deleter'], f1, ctx())).to.equal(true);
      expect(await service.coversAt(alice, ['deleter'], P2, ctx())).to.equal(true);
      expect(await service.coversAt(bob, ['deleter'], f1, ctx())).to.equal(false);
    });

    it('applies ceiling.roles and ceiling.permissions', async () => {
      const { service } = await setup([assignment('a1', alice, 'all', O1), assignment('a2', alice, 'reader', O1)]);
      expect(await service.coversAt(withCeiling(alice, { roles: ['reader'] }), ['deleter'], f1, ctx())).to.equal(false);
      expect(await service.coversAt(withCeiling(alice, { permissions: ['doc:read'] }), ['writer'], f1, ctx())).to.equal(false);
      expect(await service.coversAt(withCeiling(alice, { permissions: ['doc:read'] }), ['reader'], f1, ctx())).to.equal(true);
    });
  });

  describe('covers reads the request snapshot', () => {
    it('with a TTL of 0 covers works in the preloaded request and throws without it', async () => {
      const { model, service } = await setup([assignment('a1', alice, 'all')], { cache: { assignmentsTtlSeconds: 0 } });
      const c = ctx();
      await model.preload(alice, c);
      expect(service.covers(alice, ['reader'], undefined, c)).to.equal(true);
      expect(() => service.covers(alice, ['reader'])).to.throw(AuthzConfigError, 'not preloaded');
    });
  });
});
