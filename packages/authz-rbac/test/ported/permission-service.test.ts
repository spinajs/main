import * as chai from 'chai';
import 'mocha';

import { AccessDenied, AuthorizationModel, AuthzConfigError, AuthzContributor, AuthzService, FALSE, GLOBAL, PermissionRegistryImpl, ResourceAdapter, TRUE, UnknownPermission } from '@spinajs/authz';
import type { Assignment, PermissionInput, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { FakeAdapter, FakeRelationResolver, fakeEvaluationContext, fakeModelInitContext, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { FakeRow } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel, RbacService } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;
const { installHost, instance, registerInRoot, resetHost, uninstallHost } = testHost;
const rootService = (): Promise<AuthzService> => DI.resolve(AuthzService);

// Ported from users legacy-v2/permission-service.test.ts rows 4-10, 19-26 and 32 (B11, B12, B15, B06, B07, D14, B02, B23).
// The class-based PermissionService becomes the RbacModel's grants plus authz().assert; `owns()` becomes the `owner` relation.
const NOW = new Date('2026-10-01T12:00:00.000Z');
const widgetRef: ResourceRef = { type: 'Widget' };
const own: ResourceFilter = { op: 'relation', relation: 'owner' };

const role = (name: string, grants: readonly (string | GrantDef)[]): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, who: string, roleName: string): Assignment => ({ id, subject: { type: 'user', id: who }, role: roleName, scope: GLOBAL, source: 'test' });

const PERMISSIONS: PermissionInput[] = ['Widget:create', 'Widget:update', 'Widget:read', 'Widget:frob'].map((name) => ({ name, types: ['Widget'] }));

// admin: create and update on any; member: the same on its own; viewer: read its own.
const ROLES: RoleDef[] = [role('admin', ['Widget:create', 'Widget:update']), role('member', [{ permission: 'Widget:create', relation: 'owner' }, { permission: 'Widget:update', relation: 'owner' }]), role('viewer', [{ permission: 'Widget:read', relation: 'owner' }]), role('frobber', [{ permission: 'Widget:frob', relation: 'capacity' }])];

const warnings: string[] = [];
const log = { warn: (message: string) => void warnings.push(message) };

const registry = () => {
  const r = new PermissionRegistryImpl();
  r.register(PERMISSIONS, 'test');
  r.freeze();
  return r;
};

async function rbac(assignments: readonly Assignment[]): Promise<RbacModel> {
  const model = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(assignments), log });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  return model;
}

const vote = (model: RbacModel, principal: Principal, permission: string) => model.evaluate({ principal, permission, resource: widgetRef }, fakeEvaluationContext({ now: NOW }));
const switched = (id: string, ...roles: string[]): Principal => userPrincipal(id, { ceiling: { roles } });
const names = (list: readonly { role: string }[]) => list.map((r) => r.role).sort();

describe('RbacModel as the 2.x PermissionService grants', () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  describe('effective roles (B11, B07, D14)', () => {
    it('answers every live assignment of the principal outside any ceiling', async () => {
      const service = new RbacService(await rbac([assignment('a1', 'u1', 'member'), assignment('a2', 'u1', 'admin')]));
      expect(names(await service.rolesOf(userPrincipal('u1')))).to.deep.equal(['admin', 'member']);
    });

    it("a ceiling narrows the principal's own roles to the switched role; the full list stays available to the role switch", async () => {
      const service = new RbacService(await rbac([assignment('a1', 'u1', 'member'), assignment('a2', 'u1', 'admin')]));
      const active = switched('u1', 'member');
      expect(names(await service.rolesOf(active))).to.deep.equal(['member']);
      expect(names(await service.rolesOf(active, GLOBAL, { ceiling: false }))).to.deep.equal(['admin', 'member']);
    });

    it('a ceiling belongs to its own principal and does not narrow another one', async () => {
      const service = new RbacService(await rbac([assignment('a1', 'u1', 'member'), assignment('a2', 'u2', 'admin')]));
      expect(names(await service.rolesOf(switched('u1', 'member')))).to.deep.equal(['member']);
      expect(names(await service.rolesOf(userPrincipal('u2')))).to.deep.equal(['admin']);
    });

    it('a switch to a role the principal does not hold gives no roles, never the role', async () => {
      const service = new RbacService(await rbac([assignment('a1', 'u1', 'member')]));
      expect(await service.rolesOf(switched('u1', 'admin'))).to.deep.equal([]);
    });
  });

  describe('grant projection (B15, B01, B12)', () => {
    it('projects any as TRUE, own as a relation residual and none as FALSE', async () => {
      const model = await rbac([assignment('a1', 'admin1', 'admin'), assignment('a2', 'member1', 'member'), assignment('a3', 'viewer1', 'viewer')]);

      expect((await vote(model, userPrincipal('admin1'), 'Widget:create')).permitWhen).to.deep.equal(TRUE);
      expect((await vote(model, userPrincipal('member1'), 'Widget:create')).permitWhen).to.deep.equal(own);
      expect((await vote(model, userPrincipal('viewer1'), 'Widget:create')).permitWhen).to.deep.equal(FALSE);
    });

    it('any wins over own across several roles', async () => {
      const model = await rbac([assignment('a1', 'u1', 'member'), assignment('a2', 'u1', 'admin')]);
      expect((await vote(model, userPrincipal('u1'), 'Widget:update')).permitWhen).to.deep.equal(TRUE);
    });

    it('an unknown role counts as none, with a warning, instead of an error', async () => {
      const model = await rbac([assignment('a1', 'u1', 'ghost')]);
      expect((await vote(model, userPrincipal('u1'), 'Widget:create')).permitWhen).to.deep.equal(FALSE);
      expect(warnings.filter((w) => w.includes("'ghost'"))).to.have.length(1);
    });

    it('projects through the ceiling of the principal', async () => {
      const model = await rbac([assignment('a1', 'u1', 'member'), assignment('a2', 'u1', 'admin')]);
      expect((await vote(model, switched('u1', 'member'), 'Widget:update')).permitWhen).to.deep.equal(own);
      expect((await vote(model, switched('u1', 'admin'), 'Widget:update')).permitWhen).to.deep.equal(TRUE);
    });

    it('answers a granted role as permitting, a role without the grant as not, and an unknown one as not without throwing', async () => {
      const model = await rbac([assignment('a1', 'admin1', 'admin'), assignment('a2', 'viewer1', 'viewer'), assignment('a3', 'ghost1', 'ghost')]);
      expect((await vote(model, userPrincipal('admin1'), 'Widget:create')).permitWhen).to.not.deep.equal(FALSE);
      expect((await vote(model, userPrincipal('viewer1'), 'Widget:create')).permitWhen).to.deep.equal(FALSE);
      expect((await vote(model, userPrincipal('ghost1'), 'Widget:create')).permitWhen).to.deep.equal(FALSE);
    });
  });

  describe('through the host: Widget rows with an owner relation', function () {
    this.timeout(10000);

    let widgets: FakeAdapter;
    let capacity: FakeRelationResolver;
    const row = (id: string): FakeRow => widgets.all('Widget').find((r) => r.id === id)!;

    before(() => installHost());
    after(() => uninstallHost());

    beforeEach(async () => {
      await resetHost();
      testHost.config().set(['authz', 'permissions'], Object.fromEntries(PERMISSIONS.map(({ name, types }) => [name, { types }])));
      capacity = new FakeRelationResolver('Widget', 'capacity', () => true);
      widgets = new FakeAdapter({
        types: ['Widget'],
        rows: {
          Widget: [
            { id: '5', owner: 'member1' },
            { id: '7', owner: 'somebody-else' },
          ],
        },
        relations: [{ type: 'Widget', relation: 'owner', column: 'owner' }, capacity],
      });
      const model = new RbacModel({
        roles: new MemoryRoleStore(ROLES),
        assignments: new MemoryAssignmentStore([assignment('a1', 'admin1', 'admin'), assignment('a2', 'member1', 'member'), assignment('a3', 'member1', 'frobber'), assignment('a4', 'viewer1', 'viewer')]),
        log,
      });
      registerInRoot(AuthorizationModel, instance(model));
      registerInRoot(AuthzContributor, instance(new RbacContributor(model)));
      registerInRoot(ResourceAdapter, instance(widgets));
    });

    it('the type name is the permission resource key; any is allowed without a subject', async () => {
      const svc = await rootService();
      const decision = await svc.assert(userPrincipal('admin1'), 'Widget:create', widgetRef);
      expect(decision.residual).to.deep.equal(TRUE);
    });

    it('a permission or type the registry does not know fails loud, not closed (B02)', async () => {
      const svc = await rootService();
      const unknownPermission = await svc.assert(userPrincipal('admin1'), 'Renamed:update', { type: 'Renamed', id: '1' }).catch((e: Error) => e);
      expect(unknownPermission).to.be.instanceOf(UnknownPermission);
      expect(unknownPermission).to.not.be.instanceOf(AccessDenied);
      expect((unknownPermission as Error).message).to.contain('Renamed:update');

      const foreignType = await svc.assert(userPrincipal('admin1'), 'Widget:update', { type: 'Renamed', id: '1' }).catch((e: Error) => e);
      expect(foreignType).to.be.instanceOf(AuthzConfigError);
      expect(foreignType).to.not.be.instanceOf(AccessDenied);
    });

    it('any passes with or without a subject, never consulting the relation', async () => {
      const svc = await rootService();
      const admin = userPrincipal('admin1');
      expect((await svc.assert(admin, 'Widget:update', { type: 'Widget', id: '7' }, row('7'))).allowed).to.equal(true);
      expect((await svc.assert(admin, 'Widget:create', widgetRef)).allowed).to.equal(true);
    });

    it('no grant denies with no_access', async () => {
      const svc = await rootService();
      const error = await svc.assert(userPrincipal('viewer1'), 'Widget:update', { type: 'Widget', id: '5' }, row('5')).catch((e: Error) => e);
      expect(error).to.be.instanceOf(AccessDenied);
      expect((error as AccessDenied).decision.reason?.code).to.equal('no_access');
    });

    it('own passes when the owner relation holds for the subject', async () => {
      const svc = await rootService();
      const decision = await svc.assert(userPrincipal('member1'), 'Widget:update', { type: 'Widget', id: '5' }, row('5'));
      expect(decision.allowed).to.equal(true);
    });

    it('own refuses when the owner relation does not hold for the subject', async () => {
      const svc = await rootService();
      const error = await svc.assert(userPrincipal('member1'), 'Widget:update', { type: 'Widget', id: '7' }, row('7')).catch((e: Error) => e);
      expect(error).to.be.instanceOf(AccessDenied);
      expect((error as AccessDenied).decision.allowed).to.equal(false);
    });

    // 3.0 differs (B06, B15): without a subject a conditional permit is allowed with a residual, it does not refuse.
    it('own without a subject is allowed with the owner relation as residual', async () => {
      const svc = await rootService();
      const decision = await svc.assert(userPrincipal('member1'), 'Widget:update', widgetRef);
      expect(decision.allowed).to.equal(true);
      expect(decision.residual).to.deep.equal(own);
    });

    it('composes the verb grant with a domain relation rule, the grant first (B15, B23)', async () => {
      const svc = await rootService();
      const member = userPrincipal('member1');
      const frob = async (id: string) => {
        const ref = { type: 'Widget', id };
        await svc.assert(member, 'Widget:update', ref, row(id));
        await svc.assert(member, 'Widget:frob', ref, row(id));
      };

      await frob('5');
      expect(capacity.calls).to.be.greaterThan(0);

      capacity.calls = 0;
      const error = await frob('7').catch((e: Error) => e);
      expect(error).to.be.instanceOf(AccessDenied);
      expect((error as AccessDenied).decision.permission).to.equal('Widget:update');
      expect(capacity.calls).to.equal(0);
    });
  });
});
