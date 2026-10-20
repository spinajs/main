import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import type { AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { ref, role, assignment, later } = fixtureDsl;

const NOW = new Date('2026-10-03T00:00:00.000Z');
const P1 = ref('project', 'p1');

// lead is on no ladder and implies maintainer at p1; olga ranks editor there, omar maintainer.
const ROLES = [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings'], { ladder: 'project' }), role('lead', [], { implies: [{ role: 'maintainer', at: 'self-and-descendants' }] }), role('steward', ['authz:assignments.manage'])];
const LADDERS = [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }];

const people = Object.fromEntries(['olga', 'omar', 'dave'].map((id) => [id, userPrincipal(id)]));
const { olga, omar, dave } = people;

const world: World = {
  now: NOW,
  permissions: ['file:read', 'file:edit', 'project:settings', 'authz:assignments.manage'].map((name) => ({ name, types: ['project'] })),
  principals: people,
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: ROLES,
    ladders: LADDERS,
    assignments: [assignment('olga-st', olga, 'steward', P1), assignment('olga-ed', olga, 'editor', P1), assignment('omar-st', omar, 'steward', P1), assignment('omar-mt', omar, 'maintainer', P1), assignment('dave-lead', dave, 'lead', P1, { tags: ['keep'] })],
  },
};

describe('DefaultAdminGuard on the RbacModel: removing a role that implies a ladder role', function () {
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
    session = await harness.setup(world, { id: 'B26', part: 'guard', case: 'removal-implies', title: 'removal implies', facets: ['engine', 'admin', 'rbac', 'ladders'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  });

  afterEach(async () => {
    await session?.dispose();
  });

  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : `${results[0].error.code}:${results[0].error.field}`);
  const maintains = async (p: Principal) => {
    const d = await authz.check({ principal: p, permission: 'project:settings', resource: P1 });
    return d.allowed && d.residual.op === 'true';
  };
  const commands: AuthzCommand[] = [
    { kind: 'assignment.revoke', id: 'dave-lead' },
    { kind: 'assignment.setExpiry', id: 'dave-lead', expiresAt: later(NOW, 3600_000) },
    { kind: 'assignment.removeTags', id: 'dave-lead', tags: ['keep'] },
  ];

  it('dave maintains p1 through lead; olga ranks editor there, omar maintainer', async () => {
    expect(await maintains(dave)).to.equal(true);
    expect((await authz.check({ principal: olga, permission: 'authz:assignments.manage', resource: P1 })).roles?.project).to.equal('editor');
    expect((await authz.check({ principal: omar, permission: 'authz:assignments.manage', resource: P1 })).roles?.project).to.equal('maintainer');
  });

  it('an actor ranking below the implied maintainer may not revoke, re-expire or re-tag the row', async () => {
    for (const c of commands) expect(code(await admin.execute(olga, [c])), c.kind).to.equal('escalation:id');
    expect(await maintains(dave)).to.equal(true);
  });

  it('an actor ranking maintainer may', async () => {
    for (const c of [...commands.slice(1), commands[0]]) expect(code(await admin.execute(omar, [c])), c.kind).to.equal('ok');
    expect(await maintains(dave)).to.equal(false);
  });
});
