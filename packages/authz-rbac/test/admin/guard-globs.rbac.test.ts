import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { role, assignment } = fixtureDsl;

// Shaped like users' shipped roles: admin extends the non-assignable admin.users, which grants a glob.
const ROLES = [role('admin.users', ['users:*'], { assignable: false }), role('admin', ['user:impersonate'], { extends: ['admin.users'] }), role('superuser', ['users:read', 'users:list', 'user:impersonate', 'authz:assignments.manage']), role('reader', ['users:read', 'user:impersonate', 'authz:assignments.manage']), role('ghosts', ['nothing:*'])];

const people = Object.fromEntries(['root', 'rita', 'alice'].map((id) => [id, userPrincipal(id)]));
const { root, rita, alice } = people;

const WORLD: World = {
  now: new Date('2026-10-03T00:00:00.000Z'),
  permissions: [{ name: 'users:read' }, { name: 'users:list' }, { name: 'user:impersonate' }, { name: 'authz:assignments.manage' }],
  principals: people,
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: { roles: ROLES, assignments: [assignment('r-root', root, 'superuser', GLOBAL), assignment('r-rita', rita, 'reader', GLOBAL)] },
};

describe('DefaultAdminGuard on the RbacModel: glob grants against the permission registry', function () {
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

  beforeEach(async () => {
    session = await harness.setup(WORLD, { id: 'B12', part: 'guard', case: 'globs', title: 'globs', facets: ['engine', 'admin', 'rbac'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  });

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  const lists = async (p: Principal) => (await authz.check({ principal: p, permission: 'users:list', resource: GLOBAL })).allowed;
  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);
  const grant = (r: string): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: 'alice' }, role: r, scope: GLOBAL });

  it('an actor holding every permission a glob matches may grant a role that extends it', async () => {
    expect(code(await admin.execute(root, [grant('admin')]))).to.equal('ok');
    expect(await lists(alice)).to.equal(true);
  });

  it('an actor lacking one permission the glob matches may not', async () => {
    expect(code(await admin.execute(rita, [grant('admin')]))).to.equal('escalation');
    expect(await lists(alice)).to.equal(false);
  });

  it('a glob that matches no registered permission is refused', async () => {
    expect(code(await admin.execute(root, [grant('ghosts')]))).to.equal('escalation');
  });
});
