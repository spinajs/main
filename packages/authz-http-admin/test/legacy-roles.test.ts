import 'mocha';
import { expect } from 'chai';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourHarness, BehaviourId, HarnessSession, World, WorldConfig } from '@spinajs/authz-testing';
import type { AuthzEvent, Principal } from '@spinajs/authz';

import { adminHttpHarness, send } from './support/admin-http.js';
import type { RawResponse } from './support/admin-http.js';

const { assignment, combine, ref, role } = fixtureDsl;

const P1 = ref('project', 'p1');
const TYPES = ['org', 'project', 'file'];
const MANAGE = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage', 'authz:policies.manage', 'authz:scope.manage'];
const READ = ['authz:assignments.read', 'authz:links.read', 'authz:rules.read', 'authz:policies.read', 'authz:attributes.read'];

const root = userPrincipal('root');
const dave = userPrincipal('dave');
const lead = userPrincipal('lead');
const erin = userPrincipal('erin');
const carol = userPrincipal('carol');

// root and dave hold `admin`, which carries the privileged permission (users:update); lead manages
// assignments at p1 and holds file:read there, so it may hand out `reader` but not `writer`; `sys` is
// not assignable and carol already holds it.
const baseWorld = (config?: WorldConfig): World => ({
  now: new Date('2026-01-01T00:00:00.000Z'),
  permissions: ['file:read', 'file:edit', 'users:update', ...MANAGE, ...READ].map((name) => ({ name, types: TYPES })),
  principals: { root, dave, lead, erin, carol },
  scopes: [{ nodes: [{ ref: P1, parent: ref('org', 'o1') }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [],
    roles: [
      role('reader', ['file:read']),
      role('writer', ['file:edit']),
      role('sys', ['file:read'], { assignable: false }),
      role('manager', ['authz:assignments.manage', 'authz:assignments.read', 'file:read']),
      role('admin', ['file:read', 'file:edit', 'users:update', ...MANAGE, ...READ]),
    ],
    assignments: [
      assignment('ra', root, 'admin'),
      assignment('da', dave, 'admin'),
      assignment('l1', lead, 'manager', P1),
      assignment('e1', erin, 'reader', P1),
      assignment('c1', carol, 'sys', P1),
    ],
  },
  ...(config ? { config } : {}),
});

const grantBody = (who: string, roleName: string) => ({ subject: { type: 'user', id: who }, role: roleName, scope: P1 });
const post = (as: Principal, who: string, roleName: string): Promise<RawResponse> => send({ method: 'POST', path: '/authz/assignments', as, body: grantBody(who, roleName) });
const del = (as: Principal, id: string): Promise<RawResponse> => send({ method: 'DELETE', path: `/authz/assignments/${id}`, as });
const errorOf = (res: RawResponse) => res.body.results[0].error;

describe('2.x role tests on the admin routes', function () {
  this.timeout(30000);

  let harness: BehaviourHarness;
  let session: HarnessSession | undefined;
  let caseNo = 0;
  let title = '';

  const start = async (world: World): Promise<void> => {
    await session?.dispose();
    session = await harness.setup(world, { id: 'B43' as BehaviourId, part: 'legacy-roles', case: title, title, facets: ['http', 'engine', 'rbac', 'admin'] });
  };

  before(async () => {
    harness = adminHttpHarness();
    await harness.beforeAll?.();
  });

  after(async () => {
    await harness.afterAll?.();
  });

  beforeEach(async function () {
    title = this.currentTest?.fullTitle() ?? `case ${++caseNo}`;
    await start(baseWorld());
  });

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  const rolesOf = async (who: string): Promise<string[]> => {
    const res = await send({ method: 'GET', path: `/authz/assignments?subject=user:${who}`, as: root });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    return res.body.items.map((a: { role: string }) => a.role).sort();
  };

  const events = (): readonly AuthzEvent[] => (session!.lane as unknown as { adminEvents: { events: readonly AuthzEvent[] } }).adminEvents.events;

  describe('granting and revoking', () => {
    it('keeps the roles the user already holds when it grants another (ledger 56)', async () => {
      expect(await rolesOf('erin')).to.deep.equal(['reader']);
      const res = await post(root, 'erin', 'writer');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.results[0]).to.include({ ok: true, kind: 'assignment.grant' });
      expect(await rolesOf('erin')).to.deep.equal(['reader', 'writer']);
    });

    it('does not add a second row for an identical grant (ledger 57)', async () => {
      const first = await post(root, 'erin', 'writer');
      const again = await post(root, 'erin', 'writer');
      expect(again.status).to.equal(200);
      expect(again.body.results[0].id).to.equal(first.body.results[0].id);
      expect(await rolesOf('erin')).to.deep.equal(['reader', 'writer']);
    });

    it('revokes one role and leaves the other (ledger 58)', async () => {
      const granted = await post(root, 'erin', 'writer');
      const res = await del(root, granted.body.results[0].id);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.results[0]).to.include({ ok: true, kind: 'assignment.revoke' });
      expect(await rolesOf('erin')).to.deep.equal(['reader']);
    });
  });

  describe('role validation', () => {
    it('refuses an empty role name with 400 invalid_command (ledger 59)', async () => {
      const res = await post(root, 'erin', '');
      expect(res.status).to.equal(400);
      expect(errorOf(res)).to.deep.include({ code: 'invalid_command', field: 'role' });
      expect(await rolesOf('erin')).to.deep.equal(['reader']);
    });

    it('refuses an unknown role with 400 unknown_role (ledger 60)', async () => {
      const res = await post(root, 'erin', 'ghost');
      expect(res.status).to.equal(400);
      expect(errorOf(res).code).to.equal('unknown_role');
    });

    it('refuses a system role with 400 not_assignable (ledger 61)', async () => {
      const res = await post(root, 'erin', 'sys');
      expect(res.status).to.equal(400);
      expect(errorOf(res).code).to.equal('not_assignable');
      expect(await rolesOf('erin')).to.deep.equal(['reader']);
    });
  });

  describe('escalation and lockout', () => {
    it('refuses a role that holds more than the caller with 403 escalation (ledger 62)', async () => {
      const res = await post(lead, 'erin', 'writer');
      expect(res.status).to.equal(403);
      expect(errorOf(res).code).to.equal('escalation');
      expect(await rolesOf('erin')).to.deep.equal(['reader']);
    });

    it('lets a caller who covers the role grant it (ledger 63)', async () => {
      const res = await post(lead, 'frank', 'reader');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await rolesOf('frank')).to.deep.equal(['reader']);
    });

    it("refuses revoking the caller's own privileged role with 403 self_lockout (ledger 64)", async () => {
      const res = await del(root, 'ra');
      expect(res.status).to.equal(403);
      expect(errorOf(res).code).to.equal('self_lockout');
      expect(await rolesOf('root')).to.deep.equal(['admin']);
    });
  });

  describe('guard switches', () => {
    it('lets the escalation through with authz.admin.guard.preventEscalation off (ledger 67)', async () => {
      await start(baseWorld({ admin: { guard: { preventEscalation: false } } }));
      const res = await post(lead, 'erin', 'writer');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await rolesOf('erin')).to.deep.equal(['reader', 'writer']);
    });

    it('refuses an unknown role whatever authz.admin.guard says: 3.0 has no requireKnownRole (ledger 68)', async () => {
      await start(baseWorld({ admin: { guard: { protectSystemRole: false, preventEscalation: false, preventSelfLockout: false, preventLastPrivilegedRemoval: false } } }));
      const res = await post(root, 'erin', 'ghost');
      expect(res.status).to.equal(400);
      expect(errorOf(res).code).to.equal('unknown_role');
    });

    it('protectSystemRole on: a row of a system role cannot be revoked or edited (ledger 69)', async () => {
      const revoke = await del(root, 'c1');
      expect(revoke.status).to.equal(403);
      expect(errorOf(revoke).code).to.equal('protected_role');
      const edit = await send({ method: 'PATCH', path: '/authz/assignments/c1', as: root, body: { tags: ['x'] } });
      expect(edit.status).to.equal(403);
      expect(errorOf(edit).code).to.equal('protected_role');
      expect(await rolesOf('carol')).to.deep.equal(['sys']);
    });

    it('protectSystemRole off: the row can be edited and revoked, a grant of the role is still refused (ledger 69)', async () => {
      await start(baseWorld({ admin: { guard: { protectSystemRole: false } } }));
      const grant = await post(root, 'erin', 'sys');
      expect(grant.status).to.equal(400);
      expect(errorOf(grant).code).to.equal('not_assignable');
      const edit = await send({ method: 'PATCH', path: '/authz/assignments/c1', as: root, body: { tags: ['x'] } });
      expect(edit.status, JSON.stringify(edit.body)).to.equal(200);
      const revoke = await del(root, 'c1');
      expect(revoke.status, JSON.stringify(revoke.body)).to.equal(200);
      expect(await rolesOf('carol')).to.deep.equal([]);
    });
  });

  describe('roles the caller may assign (ledger 71)', () => {
    const dryRun = (as: Principal, roleName: string) => send({ method: 'POST', path: '/authz/commands', as, body: { dryRun: true, commands: [{ kind: 'assignment.grant', ...grantBody('frank', roleName) }] } });

    it('a dry run answers ok for a role the caller covers and writes nothing', async () => {
      const res = await dryRun(lead, 'reader');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.results[0]).to.include({ ok: true, kind: 'assignment.grant' });
      expect(await rolesOf('frank')).to.deep.equal([]);
    });

    it('a dry run answers escalation for a role the caller does not cover and writes nothing', async () => {
      const res = await dryRun(lead, 'writer');
      expect(res.status).to.equal(403);
      expect(errorOf(res).code).to.equal('escalation');
      expect(await rolesOf('frank')).to.deep.equal([]);
    });
  });

  describe('events', () => {
    it('a grant and a revoke emit RoleAssigned and RoleRevoked with the request principal as actor (B27)', async () => {
      const before = events().length;
      const granted = await post(lead, 'frank', 'reader');
      const revoked = await del(lead, granted.body.results[0].id);
      expect(revoked.status, JSON.stringify(revoked.body)).to.equal(200);
      const fresh = events().slice(before);
      expect(fresh.map((e) => e.type)).to.deep.equal(['RoleAssigned', 'RoleRevoked']);
      for (const e of fresh) {
        expect(e.actor).to.deep.include({ type: 'user', id: 'lead' });
        expect(e.data).to.deep.include({ id: granted.body.results[0].id, role: 'reader' });
      }
    });
  });
});
