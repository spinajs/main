import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { role, assignment } = fixtureDsl;

const people = Object.fromEntries(['root', 'dave', 'erin', 'ops'].map((id) => [id, userPrincipal(id)]));
const { root, dave, erin, ops } = people;

// users:update is the default privilegedPermission. dave's and erin's rows grant it, but the model ignores
// them: sys is assignable: false, org.boss may not be held at GLOBAL.
const world: World = {
  now: new Date('2026-10-03T00:00:00.000Z'),
  permissions: [{ name: 'users:update' }, { name: 'authz:assignments.manage' }],
  principals: people,
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('admin', ['users:update']), role('sys', ['users:update'], { assignable: false }), role('org.boss', ['users:update'], { scopeTypes: ['org'] }), role('ops', ['authz:assignments.manage'])],
    assignments: [assignment('a-root', root, 'admin', GLOBAL), assignment('s-dave', dave, 'sys', GLOBAL), assignment('ob-erin', erin, 'org.boss', GLOBAL), assignment('o-ops', ops, 'ops', GLOBAL)],
  },
};

describe('DefaultAdminGuard on the RbacModel: holders are rows the model honours', function () {
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

  beforeEach(async () => {
    session = await harness.setup(world, { id: 'B26', part: 'guard', case: 'holders', title: 'holders', facets: ['engine', 'admin', 'rbac'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  });

  afterEach(async () => {
    await session?.dispose();
  });

  const holds = async (p: Principal) => {
    const d = await authz.check({ principal: p, permission: 'users:update', resource: GLOBAL });
    return d.allowed && d.residual.op === 'true';
  };
  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);

  it('only root holds users:update', async () => {
    expect([await holds(root), await holds(dave), await holds(erin)]).to.deep.equal([true, false, false]);
  });

  it('revoking the last real holder is refused last_holder; the system row stays protected', async () => {
    expect(code(await admin.execute(ops, [{ kind: 'assignment.revoke', id: 'a-root' }]))).to.equal('last_holder');
    expect(await holds(root)).to.equal(true);
    expect(code(await admin.execute(ops, [{ kind: 'assignment.revoke', id: 's-dave' }]))).to.equal('protected_role');
    expect(code(await admin.execute(ops, [{ kind: 'assignment.revoke', id: 'ob-erin' }]))).to.equal('ok');
  });
});
