import { AuthzConfigError, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { PermissionInput, ResourceRef } from '@spinajs/authz';
import type { Assignment } from '../../src/contracts.js';
import { FakeScopeResolver, ManualClock, anonymousPrincipal, fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
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
  { name: 'page:view', types: ['file'], fields: true },
];

const ROLES: RoleDef[] = [role('reader', ['doc:read']), role('writer', ['doc:write'], { extends: ['reader'] }), role('all', ['doc:*']), role('ownerWriter', [{ permission: 'doc:write', relation: 'owner' }]), role('eitherWriter', [{ permission: 'doc:write', relation: ['owner', 'editor'] }]), role('names', [{ permission: 'user:read', fields: { read: ['name'] } }]), role('contacts', [{ permission: 'user:read', fields: { read: ['name', 'email'] } }]), role('users', ['user:read']), role('home', [{ permission: 'dir:list', on: [{ type: 'dir', id: 'home/{principal.id}' }] }]), role('home2', [{ permission: 'dir:list', on: [{ type: 'dir', id: 'home/{principal.id}' }] }]), role('tmp', [{ permission: 'dir:list', on: [{ type: 'dir', id: 'tmp' }] }]), role('dirs', ['dir:list']), role('tagged', [{ permission: 'doc:delete', requiresTag: 'danger' }]), role('deleter', ['doc:delete']), role('typedReader', [{ permission: 'doc:read', on: [{ type: 'file' }] }]), role('noteTyped', [{ permission: 'note:read', on: [{ type: 'file' }] }]), role('globReader', [{ permission: 'doc:read', on: [{ type: 'file', id: 'pub/*' }] }]), role('noteReader', ['note:read']), role('writerOnly', ['doc:write']), role('pageNames', [{ permission: 'page:view', fields: { read: ['name'], write: [] } }]), role('pageViewer', ['page:view']), role('pageA', [{ permission: 'page:view', fields: { read: ['a'], write: [] } }]), role('pageB', [{ permission: 'page:view', fields: { read: ['b'], write: [] } }])];

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

  describe('rolesOf', () => {
    const held = [assignment('g1', alice, 'reader'), assignment('o1', alice, 'writer', O1, { expiresAt: new Date(NOW.getTime() + HOUR) }), assignment('p2', alice, 'all', P2), assignment('b1', bob, 'all')];

    it('gives the roles live on the path of `at`, with scope and expiry', async () => {
      const { service } = await setup(held);
      expect(await service.rolesOf(alice)).to.deep.equal([{ role: 'reader', scope: GLOBAL, assignment: 'g1', source: 'test', effectiveRole: 'reader' }]);
      const atFile = await service.rolesOf(alice, f1, { ctx: ctx() });
      expect(roleNames(atFile)).to.deep.equal(['reader', 'writer']);
      expect(atFile.find((r) => r.role === 'writer')).to.deep.equal({ role: 'writer', scope: O1, assignment: 'o1', source: 'test', expiresAt: new Date(NOW.getTime() + HOUR), effectiveRole: 'writer' });
    });

    it('applies the ceiling unless asked for the assigned roles (a role switch must see them)', async () => {
      const { service } = await setup(held);
      const narrowed = withCeiling(alice, { roles: ['writer'] });
      expect(roleNames(await service.rolesOf(narrowed, f1, { ctx: ctx() }))).to.deep.equal(['writer']);
      expect(roleNames(await service.rolesOf(narrowed, f1, { ctx: ctx(), ceiling: false }))).to.deep.equal(['reader', 'writer']);
    });

    it('includes config roles', async () => {
      const { service } = await setup([], { anonymousRoles: ['reader'] });
      expect(await service.rolesOf(anonymousPrincipal())).to.deep.equal([{ role: 'reader', scope: GLOBAL, assignment: 'config:anonymousRoles:reader', source: 'config:anonymousRoles', effectiveRole: 'reader' }]);
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

      it('fields list every grant that permits some row, scoped and conditional ones too (E1 review I1)', async () => {
        const names = await setup([assignment('a1', alice, 'pageNames'), assignment('a2', alice, 'pageViewer', P1)]);
        expect((await names.model.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'page:view', conditional: false, fields: { read: ['*'], write: ['*'] } }]);
        const disjoint = await setup([assignment('a1', alice, 'pageA', P1), assignment('a2', alice, 'pageB', P2)]);
        expect((await disjoint.model.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'page:view', conditional: true, fields: { read: ['a', 'b'], write: [] } }]);
        const alone = await setup([assignment('a1', alice, 'pageNames')]);
        expect((await alone.model.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'page:view', conditional: false, fields: { read: ['name'], write: [] } }]);
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
});
