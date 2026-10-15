import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import type { Assignment } from '../../src/contracts.js';

import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { role, assignment } = fixtureDsl;

const people = Object.fromEntries(['root', 'erin', 'ops', 'dave'].map((id) => [id, userPrincipal(id)]));
const { root, erin, ops, dave } = people;
const P1 = { type: 'project', id: 'p1' };
const T1 = { type: 'team', id: 't1' };

// users:update is the default privilegedPermission.
const blocked = { ...role('blocked', ['users:update']), deny: true } as ReturnType<typeof role>;
const strict = { ...role('strict', [], { extends: ['blocked'] }), deny: true } as ReturnType<typeof role>;
const world = (holders: readonly string[], extra: readonly Assignment[] = []): World => ({
  now: new Date('2026-10-14T00:00:00.000Z'),
  permissions: [{ name: 'users:update' }, { name: 'authz:assignments.manage', types: ['project', 'team'] }],
  principals: people,
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('admin', ['users:update', 'authz:assignments.manage']), role('ops', ['authz:assignments.manage']), role('team.member', [], { subjectSet: true }), blocked, strict],
    assignments: [...holders.map((h) => assignment(`a-${h}`, people[h], 'admin', GLOBAL)), assignment('o-ops', ops, 'ops', GLOBAL), ...extra],
  },
});

describe('DefaultAdminGuard and deny roles (design §4.2)', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness();
  let session: HarnessSession;
  let admin: AuthzAdmin;
  let authz: AuthzService;

  before(async () => {
    await harness.beforeAll?.();
  });

  after(async () => {
    await harness.afterAll?.();
  });

  async function open(holders: readonly string[], extra: readonly Assignment[] = []): Promise<void> {
    session = await harness.setup(world(holders, extra), { id: 'B26', part: 'guard', case: 'deny', title: 'deny roles', facets: ['engine', 'admin', 'rbac'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  }

  afterEach(async () => {
    await session?.dispose();
  });

  const grant = (actor: Principal, subject: { type: string; id: string }, scope = GLOBAL) => admin.execute(actor, [{ kind: 'assignment.grant', subject, role: 'blocked', scope }]);
  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);
  const holds = async (p: Principal) => {
    const d = await authz.check({ principal: p, permission: 'users:update', resource: GLOBAL });
    return d.allowed && d.residual.op === 'true';
  };

  it('granting a deny role is no escalation', async () => {
    await open(['root']);
    expect(code(await grant(ops, dave))).to.equal('ok');
  });

  it('a deny of the privileged permission to its last holder is last_holder, also through a wildcard', async () => {
    await open(['root']);
    expect(code(await grant(ops, root))).to.equal('last_holder');
    expect(code(await grant(ops, { type: 'user', id: '*' }))).to.equal('last_holder');
    expect(await holds(root)).to.equal(true);
  });

  it('a deny of the privileged permission to the actor itself is self_lockout, at any scope', async () => {
    await open(['root', 'erin']);
    expect(code(await grant(root, root))).to.equal('self_lockout');
    expect(code(await grant(root, root, P1))).to.equal('self_lockout');
  });

  it('with another holder left, the deny goes through and removes the permission', async () => {
    await open(['root', 'erin']);
    expect(code(await grant(ops, root))).to.equal('ok');
    expect(await holds(root)).to.equal(false);
    expect(await holds(erin)).to.equal(true);
  });

  it('a deny role that extends one denying the privileged permission counts too', async () => {
    await open(['root']);
    expect(code(await admin.execute(ops, [{ kind: 'assignment.grant', subject: root, role: 'strict', scope: GLOBAL }]))).to.equal('last_holder');
  });

  describe('joining a set that holds a deny of the privileged permission', () => {
    const denied = { id: 's-team', subject: { set: { role: 'team.member', scope: T1 } }, role: 'blocked', scope: GLOBAL, source: 'test' } as Assignment;
    const join = (actor: Principal, member: Principal) => admin.execute(actor, [{ kind: 'set.addMember', set: { role: 'team.member', scope: T1 }, member }]);

    it('is self_lockout for the actor', async () => {
      await open(['root', 'erin'], [denied]);
      expect(code(await join(root, root))).to.equal('self_lockout');
      expect(code(await join(ops, root))).to.equal('ok');
    });

    it('is last_holder for the last holder', async () => {
      await open(['root'], [denied]);
      expect(code(await join(ops, root))).to.equal('last_holder');
      expect(code(await join(ops, dave))).to.equal('ok');
    });
  });

  it('renewing a lapsed deny row counts as a removal', async () => {
    await open(['root'], [assignment('d-root', root, 'blocked', GLOBAL, { expiresAt: new Date('2026-10-01T00:00:00.000Z') })]);
    expect(code(await admin.execute(ops, [{ kind: 'assignment.setExpiry', id: 'd-root', expiresAt: null }]))).to.equal('last_holder');
  });

  it('revoking a deny row is no removal', async () => {
    await open(['root', 'erin'], [assignment('d-root', root, 'blocked', P1)]);
    expect(code(await admin.execute(root, [{ kind: 'assignment.revoke', id: 'd-root' }]))).to.equal('ok');
  });

  it('SYSTEM is not subject to a deny', async () => {
    await open(['root', 'erin']);
    await grant(ops, { type: 'user', id: '*' });
    expect(await holds(SYSTEM)).to.equal(true);
  });
});
