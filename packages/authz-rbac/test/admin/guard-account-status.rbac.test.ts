import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL, principalKey } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommandResult, AuthzService, Principal, PrincipalRef } from '@spinajs/authz';

import { AccountStatusSource } from '../../src/index.js';
import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { role, assignment } = fixtureDsl;
const { instance } = testHost;

const people = Object.fromEntries(['root', 'root2', 'ops'].map((id) => [id, userPrincipal(id)]));
const { root, root2, ops } = people;

const world: World = {
  now: new Date('2026-10-03T00:00:00.000Z'),
  permissions: [{ name: 'users:update' }, { name: 'authz:assignments.manage' }],
  principals: people,
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('admin', ['users:update']), role('ops', ['authz:assignments.manage'])],
    assignments: [assignment('a-root', root, 'admin', GLOBAL), assignment('a-root2', root2, 'admin', GLOBAL), assignment('o-ops', ops, 'ops', GLOBAL)],
  },
};

/** In service: the principal keys in `states` set to true; every call is recorded. */
class FakeAccountStatus extends AccountStatusSource {
  states: Record<string, boolean> = {};
  readonly calls: (readonly PrincipalRef[])[] = [];

  async inService(refs: readonly PrincipalRef[]): Promise<ReadonlyMap<string, boolean>> {
    this.calls.push(refs);
    return new Map(refs.map((r) => [principalKey(r), this.states[principalKey(r)] === true]));
  }
}

describe('DefaultAdminGuard on the RbacModel: last_holder asks the AccountStatusSource', function () {
  this.timeout(30000);
  const source = new FakeAccountStatus();
  const harness = rbacAdminHarness({ register: (host) => host.container.register(instance(source)).as(AccountStatusSource) });
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
    source.states = {};
    source.calls.length = 0;
    session = await harness.setup(world, { id: 'B26', part: 'guard', case: 'account-status', title: 'account status', facets: ['engine', 'admin', 'rbac'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  });

  afterEach(async () => {
    await session?.dispose();
  });

  const holds = async (p: Principal) => (await authz.check({ principal: p, permission: 'users:update', resource: GLOBAL })).allowed;
  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);

  it('the other admin out of service: revoking root is refused last_holder and root keeps the privilege', async () => {
    source.states = { 'user:root': true, 'user:root2': false };
    expect(code(await admin.execute(ops, [{ kind: 'assignment.revoke', id: 'a-root' }]))).to.equal('last_holder');
    expect(await holds(root)).to.equal(true);
    expect(source.calls).to.deep.equal([[{ type: 'user', id: 'root2' }]]);
  });

  it('the other admin in service: revoking root passes', async () => {
    source.states = { 'user:root2': true };
    expect(code(await admin.execute(ops, [{ kind: 'assignment.revoke', id: 'a-root' }]))).to.equal('ok');
    expect(await holds(root)).to.equal(false);
    expect(await holds(root2)).to.equal(true);
  });
});
