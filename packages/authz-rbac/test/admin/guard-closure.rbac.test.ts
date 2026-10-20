import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import type { Assignment } from '../../src/index.js';
import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { ref, role, assignment } = fixtureDsl;

const NOW = new Date('2026-10-03T00:00:00.000Z');
const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const NODES = ['org', 'project', 'file'];

// Canvas-shaped org ladder (design §8.5) without org.admin's implied maintainer: the set path is the only
// way an org role reaches the project here.
const ROLES = [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings'], { ladder: 'project' }), role('org.guest', [], { ladder: 'org' }), role('org.member', ['org:read'], { ladder: 'org', subjectSet: true }), role('org.admin', ['org:manage', 'authz:assignments.manage'], { ladder: 'org' }), role('org.owner', ['org:billing'], { ladder: 'org' }), role('org.lead', [], { subjectSet: true, extends: ['org.member'] })];
const LADDERS = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] },
  { name: 'org', roles: ['org.guest', 'org.member', 'org.admin', 'org.owner'] },
];

const people = Object.fromEntries(['olga', 'omar', 'dave'].map((id) => [id, userPrincipal(id)]));
const { olga, omar, dave } = people;
const user = (p: Principal) => ({ type: p.type, id: p.id });

// olga and omar run the org from a GLOBAL row: that makes neither a member of org.member at o1, so their
// project rank comes from their own project rows only.
const world: World = {
  now: NOW,
  permissions: ['file:read', 'file:edit', 'project:settings', 'org:read', 'org:manage', 'org:billing', 'authz:assignments.manage'].map((name) => ({ name, types: NODES })),
  principals: people,
  scopes: [{ nodes: [{ ref: P1, parent: O1 }] }],
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: ROLES,
    ladders: LADDERS,
    assignments: [{ id: 'set-mt', subject: { set: { role: 'org.member', scope: O1 } }, role: 'maintainer', scope: P1, source: 'test' } as Assignment, assignment('olga-own', olga, 'org.owner', GLOBAL), assignment('olga-ed', olga, 'editor', P1), assignment('omar-own', omar, 'org.owner', GLOBAL), assignment('omar-mt', omar, 'maintainer', P1)],
  },
};

describe('DefaultAdminGuard on the RbacModel: subject sets through role closures', function () {
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
    session = await harness.setup(world, { id: 'B26', part: 'guard', case: 'closure', title: 'closure', facets: ['engine', 'admin', 'rbac', 'ladders'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  });

  afterEach(async () => {
    await session?.dispose();
  });

  const run = (actor: Principal, commands: AuthzCommand[]) => admin.execute(actor, commands);
  const refusal = (results: readonly AuthzCommandResult[]) => {
    const r = results[0];
    if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
    return { code: r.error.code, field: r.error.field, message: r.error.message };
  };
  const ok = (results: readonly AuthzCommandResult[]) => {
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).to.equal(true);
  };
  const projectRole = async (p: Principal) => {
    const d = await authz.check({ principal: p, permission: 'project:settings', resource: P1 });
    return { allowed: d.allowed && d.residual.op === 'true', role: d.roles?.project };
  };
  const promote = (r = 'org.admin'): AuthzCommand => ({ kind: 'assignment.grant', subject: user(dave), role: r, scope: O1 });
  const addLead: AuthzCommand = { kind: 'set.addMember', set: { role: 'org.lead', scope: O1 }, member: user(dave) };

  it('the actors rank as the scenario needs', async () => {
    expect(await projectRole(olga)).to.deep.equal({ allowed: false, role: 'editor' });
    expect(await projectRole(omar)).to.deep.equal({ allowed: true, role: 'maintainer' });
    expect((await authz.check({ principal: olga, permission: 'org:manage', resource: O1 })).roles?.org).to.equal('org.owner');
    expect(await projectRole(dave)).to.deep.equal({ allowed: false, role: undefined });
  });

  it('granting org.admin at the org gives the maintainer the org.member set holds at the project', async () => {
    const r = refusal(await run(olga, [promote()]));
    expect([r.code, r.field]).to.deep.equal(['escalation', 'role']);
    expect(r.message).to.include('"maintainer"');
    expect(await projectRole(dave)).to.deep.equal({ allowed: false, role: undefined });
    ok(await run(omar, [promote()]));
    expect(await projectRole(dave)).to.deep.equal({ allowed: true, role: 'maintainer' });
  });

  it('adding a member to a set role that extends org.member gives the same', async () => {
    const r = refusal(await run(olga, [addLead]));
    expect([r.code, r.field]).to.deep.equal(['escalation', 'set.role']);
    ok(await run(omar, [addLead]));
    expect(await projectRole(dave)).to.deep.equal({ allowed: true, role: 'maintainer' });
  });

  it('a role below org.member gives nothing through the set', async () => {
    ok(await run(olga, [promote('org.guest')]));
    expect(await projectRole(dave)).to.deep.equal({ allowed: false, role: undefined });
  });

  it('revoking org.admin takes the maintainer away, so it needs the rank too', async () => {
    const [granted] = await run(omar, [promote()]);
    if (!granted.ok || granted.id === undefined) throw new Error(`expected a grant, got ${JSON.stringify(granted)}`);
    const r = refusal(await run(olga, [{ kind: 'assignment.revoke', id: granted.id }]));
    expect([r.code, r.field]).to.deep.equal(['escalation', 'id']);
    expect(await projectRole(dave)).to.deep.equal({ allowed: true, role: 'maintainer' });
    ok(await run(omar, [{ kind: 'assignment.revoke', id: granted.id }]));
    expect(await projectRole(dave)).to.deep.equal({ allowed: false, role: undefined });
  });
});
