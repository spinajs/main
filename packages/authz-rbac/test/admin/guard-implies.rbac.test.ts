import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import type { Assignment } from '../../src/index.js';
import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { role, assignment } = fixtureDsl;

// users:update is the default privilegedPermission; super reaches it only through users:manage, which implies it.
const ROLES = [role('admin', ['users:update']), role('super', ['users:manage', 'authz:assignments.manage']), role('tsuper', [{ permission: 'users:manage', requiresTag: 'mfa' }]), role('ops', ['authz:assignments.manage'])];

const people = Object.fromEntries(['root', 'dave', 'ops'].map((id) => [id, userPrincipal(id)]));
const { root, dave, ops } = people;

const worldOf = (rows: readonly Assignment[]): World => ({
  now: new Date('2026-10-03T00:00:00.000Z'),
  permissions: [{ name: 'users:update' }, { name: 'users:manage', implies: ['users:update'] }, { name: 'authz:assignments.manage' }],
  principals: people,
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: { roles: ROLES, assignments: [assignment('o-ops', ops, 'ops', GLOBAL), ...rows] },
});

describe('DefaultAdminGuard on the RbacModel: permissions that imply privilegedPermission', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness();
  let session: HarnessSession | undefined;
  let admin: AuthzAdmin;
  let authz: AuthzService;

  before(async () => {
    await harness.beforeAll?.();
  });

  after(async () => {
    await harness.afterAll?.();
  });

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  const open = async (rows: readonly Assignment[]) => {
    await session?.dispose();
    session = await harness.setup(worldOf(rows), { id: 'B26', part: 'guard', case: 'implies', title: 'implies', facets: ['engine', 'admin', 'rbac'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  };
  const holds = async (p: Principal) => {
    const d = await authz.check({ principal: p, permission: 'users:update', resource: GLOBAL });
    return d.allowed && d.residual.op === 'true';
  };
  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);
  const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });

  it('last_holder: revoking the only row that gives the permission through implies is refused', async () => {
    await open([assignment('s-root', root, 'super', GLOBAL)]);
    expect(await holds(root)).to.equal(true);
    expect(code(await admin.execute(ops, [revoke('s-root')]))).to.equal('last_holder');
    expect(await holds(root)).to.equal(true);
  });

  it('self_lockout: the actor may not revoke its own row that gives the permission through implies', async () => {
    await open([assignment('s-root', root, 'super', GLOBAL), assignment('a-dave', dave, 'admin', GLOBAL)]);
    expect(code(await admin.execute(root, [revoke('s-root')]))).to.equal('self_lockout');
    expect(await holds(root)).to.equal(true);
  });

  it('a holder through implies is a sure holder, so another holder may go', async () => {
    await open([assignment('a-root', root, 'admin', GLOBAL), assignment('s-dave', dave, 'super', GLOBAL)]);
    expect(await holds(dave)).to.equal(true);
    expect(code(await admin.execute(ops, [revoke('a-root')]))).to.equal('ok');
    expect(await holds(dave)).to.equal(true);
  });

  it('a holder through implies whose grant needs a tag is not sure', async () => {
    await open([assignment('a-root', root, 'admin', GLOBAL), assignment('t-dave', dave, 'tsuper', GLOBAL)]);
    expect(await holds(dave)).to.equal(false);
    expect(code(await admin.execute(ops, [revoke('a-root')]))).to.equal('last_holder');
  });
});
