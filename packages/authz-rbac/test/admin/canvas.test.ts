import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, linkPrincipal, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { AuthzAdminFailure } from '@spinajs/authz';
import type { AuthzAdmin, AuthzChange, AuthzCommand, AuthzService, LinkDef, Principal, ResourceRef, RuleDef } from '@spinajs/authz';

import type { Assignment, AssignmentSubject } from '../../src/index.js';
import { adminHarness } from './admin-harness.js';
import type { RecordingEventSink } from './admin-harness.js';

const expect = chai.expect;
const { ref, role } = fixtureDsl;

const NOW = new Date('2026-10-03T00:00:00.000Z');
const DAY = 24 * 3600_000;

const O1 = ref('org', 'o1');
const G1 = ref('group', 'g1');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const F1 = ref('file', 'f1');
const F2 = ref('file', 'f2');
const B1 = ref('branch', 'b1');

const NODES = ['org', 'project', 'file', 'branch'];
const PW = ['project', 'org'];

// The parts of the canvas config (design §8.5) the scenario exercises.
const PROJECT_PERMISSIONS = ['project:read', 'project:export', 'inspect:view', 'code:view', 'history:read', 'repo:read', 'comment:create', 'file:edit', 'repo:push', 'branch:merge', 'grants:invite', 'project:settings', 'grants:manage', 'project:delete'];
const ORG_PERMISSIONS = ['org:manage', 'audit:read', 'org:billing'];

const ROLES = [
  role('viewer', ['project:read', 'project:export', { permission: 'inspect:view', requiresTag: 'inspect' }, { permission: 'code:view', requiresTag: 'code' }, 'history:read', { permission: 'repo:read', grantedAt: PW }], { ladder: 'project' }),
  role('commenter', ['comment:create'], { ladder: 'project' }),
  role('editor', ['file:edit', ...['repo:push', 'branch:merge', 'grants:invite'].map((permission) => ({ permission, grantedAt: PW }))], { ladder: 'project' }),
  role(
    'maintainer',
    ['project:settings', 'grants:manage', 'project:delete'].map((permission) => ({ permission, grantedAt: PW })),
    { ladder: 'project' },
  ),
  role('org.file_guest', [], { ladder: 'org' }),
  role('org.guest', [], { ladder: 'org' }),
  role('org.member', [], { ladder: 'org', subjectSet: true }),
  role('org.admin', ['org:manage', 'audit:read'], { ladder: 'org', implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect', 'code'], bypass: ['restrict', 'cap'] }] }),
  role('org.owner', ['org:billing'], { ladder: 'org' }),
  role('group.member', [], { subjectSet: true }),
];

const LADDERS = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file', 'branch'] },
  { name: 'org', roles: ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'] },
];

const ORG_SCHEMA = {
  scopeType: 'org',
  schema: {
    type: 'object',
    properties: { policies: { type: 'object', properties: { public_links: { type: 'boolean' }, external_sharing: { type: 'boolean' }, viewers_may_download: { type: 'boolean' } }, additionalProperties: false } },
    additionalProperties: false,
  },
  defaults: { policies: { public_links: true, external_sharing: true, viewers_may_download: true } },
};

// Canvas maps the AuthzAdmin kinds to its own C6 capabilities (design §6.6.4). set.*, scope.forget below the
// org and the list reads are not in that table; these are the scenario's choices.
const ADMIN_PERMISSIONS = {
  'assignment.*': { project: 'grants:manage', file: 'grants:manage', org: 'org:manage' },
  'set.*': 'org:manage',
  'link.*': 'grants:manage',
  'rule.*': 'project:settings',
  'scope.*': { org: 'org:manage', project: 'project:delete', file: 'project:delete' },
  'list.*': { org: 'org:manage', group: 'org:manage', project: 'grants:manage', file: 'grants:manage' },
  'list.rules': 'project:settings',
};

const people = Object.fromEntries(['olga', 'alice', 'bob', 'carol', 'dave', 'erin', 'mallory'].map((id) => [id, userPrincipal(id)]));
const { olga, alice, bob, carol, dave, erin, mallory } = people;
const user = (p: Principal) => ({ type: p.type, id: p.id });

const world: World = {
  now: NOW,
  permissions: [...PROJECT_PERMISSIONS.map((name) => ({ name, types: NODES })), ...ORG_PERMISSIONS.map((name) => ({ name, types: [...NODES, 'group'] }))],
  principals: people,
  scopes: [
    {
      nodes: [
        { ref: G1, parent: O1 },
        { ref: P1, parent: O1 },
        { ref: P2, parent: O1 },
        { ref: F1, parent: P1 },
        { ref: F2, parent: P1 },
        { ref: B1, parent: F1, attributes: { name: 'release/1.0' } },
      ],
    },
  ],
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: { roles: ROLES, ladders: LADDERS, assignments: [fixtureDsl.assignment('owner', olga, 'org.owner', O1)] },
  scopeAttributes: { schemas: [ORG_SCHEMA] },
  config: { admin: { permissions: ADMIN_PERMISSIONS } },
};

describe('AuthzAdmin: canvas C6 writes (design §6.6.4)', function () {
  this.timeout(30000);
  const harness = adminHarness({ facets: ['scopeAttributes'] });
  let session: HarnessSession;

  before(async () => {
    await harness.beforeAll?.();
    session = await harness.setup(world, { id: 'B43', part: 'canvas', case: 'canvas', title: 'canvas', facets: ['engine', 'admin', 'rbac', 'ladders', 'scopeAttributes', 'audit', 'bus'] });
  });

  after(async () => {
    await session?.dispose();
    await harness.afterAll?.();
  });

  it('every authz row of a C6 write goes through AuthzAdmin as the acting user', async () => {
    const admin = session.admin as AuthzAdmin;
    const authz = session.authz as unknown as AuthzService;
    const published = () => (session.bus!.published ?? []) as readonly AuthzChange[];

    const decide = async (p: Principal, permission: string, resource: ResourceRef) => {
      const d = await authz.check({ principal: p, permission, resource });
      return { allowed: d.allowed && d.residual.op === 'true', roles: d.roles };
    };
    const allows = async (p: Principal, permission: string, resource: ResourceRef) => (await decide(p, permission, resource)).allowed;
    const rows = async (scope: ResourceRef, subject?: AssignmentSubject) => (await admin.list(olga, { kind: 'assignments', scope, ...(subject ? { subject } : {}) })).items as Assignment[];
    const rolesOf = async (scope: ResourceRef, subject: AssignmentSubject) => (await rows(scope, subject)).map((a) => a.role).sort();
    const refused = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect(e).to.be.instanceOf(AuthzAdminFailure);
        return (e as AuthzAdminFailure).code;
      }
      throw new Error('expected an AuthzAdminFailure');
    };
    const ok = (results: readonly { ok: boolean }[]) => {
      expect(
        results.every((r) => r.ok),
        JSON.stringify(results),
      ).to.equal(true);
      return results as readonly { ok: true; id?: string; affected: number }[];
    };

    // Add org members, then change one's org role: org.member rows at org:o1, one per user (replaceLadder).
    const members = [alice, bob, carol, dave, erin].map((p): AuthzCommand => ({ kind: 'assignment.grant', subject: user(p), role: 'org.member', scope: O1, replaceLadder: true }));
    ok(await admin.execute(olga, members));
    expect(await rows(O1)).to.have.length(6);
    const promoted = await admin.assign(olga, { subject: user(erin), role: 'org.admin', scope: O1, replaceLadder: true });
    expect(promoted.role).to.equal('org.admin');
    expect(await rolesOf(O1, user(erin))).to.deep.equal(['org.admin']);
    expect(await decide(erin, 'project:settings', F1)).to.deep.equal({ allowed: true, roles: { org: 'org.admin', project: 'maintainer' } });
    expect(await allows(dave, 'project:settings', P1)).to.equal(false);
    // A member lacks org:manage, so it cannot add members.
    expect(await refused(admin.assign(dave, { subject: user(mallory), role: 'org.member', scope: O1 }))).to.equal('forbidden');

    // Grant a project role with an add-on to a user, change its role, then its add-ons.
    const first = await admin.assign(olga, { subject: user(alice), role: 'editor', scope: P1, tags: ['inspect'], replaceLadder: true });
    expect(await decide(alice, 'file:edit', F1)).to.deep.equal({ allowed: true, roles: { org: 'org.member', project: 'editor' } });
    expect(await allows(alice, 'inspect:view', F1)).to.equal(true);
    expect(await allows(alice, 'code:view', F1)).to.equal(false);
    const changed = await admin.assign(olga, { subject: user(alice), role: 'maintainer', scope: P1, tags: ['inspect'], replaceLadder: true });
    expect(changed.id).to.not.equal(first.id);
    expect(await rolesOf(P1, user(alice))).to.deep.equal(['maintainer']);
    await admin.setTags(olga, changed.id, ['inspect', 'code']);
    expect(await allows(alice, 'code:view', F1)).to.equal(true);
    expect(await allows(alice, 'grants:manage', F1)).to.equal(true);

    // A project maintainer grants a file role and adds an add-on to it; a file grant reaches no sibling and no
    // project-wide permission.
    const bobFile = await admin.assign(alice, { subject: user(bob), role: 'viewer', scope: F1, replaceLadder: true });
    ok(await admin.execute(alice, [{ kind: 'assignment.addTags', id: bobFile.id, tags: ['inspect'] }]));
    expect((await rows(F1, user(bob)))[0].tags).to.deep.equal(['inspect']);
    expect(await allows(bob, 'project:read', F1)).to.equal(true);
    expect(await allows(bob, 'inspect:view', F1)).to.equal(true);
    expect(await allows(bob, 'project:read', F2)).to.equal(false);
    expect(await allows(bob, 'repo:read', F1)).to.equal(false);
    expect(await refused(admin.assign(mallory, { subject: user(mallory), role: 'viewer', scope: F1 }))).to.equal('forbidden');
    expect(await refused(admin.assign(bob, { subject: user(carol), role: 'viewer', scope: F1 }))).to.equal('forbidden');

    // Grant to a group, and add a group member.
    const GROUP: AssignmentSubject = { set: { role: 'group.member', scope: G1 } };
    await admin.assign(olga, { subject: GROUP, role: 'commenter', scope: P1, replaceLadder: true });
    ok(await admin.execute(olga, [{ kind: 'set.addMember', set: { role: 'group.member', scope: G1 }, member: user(carol) }]));
    expect(await rolesOf(G1, user(carol))).to.deep.equal(['group.member']);
    expect(await decide(carol, 'comment:create', F1)).to.deep.equal({ allowed: true, roles: { org: 'org.member', project: 'commenter' } });

    // Remove grants: by id, and every grant of a subject at a scope.
    await admin.revoke(alice, bobFile.id);
    expect(await rows(F1, user(bob))).to.deep.equal([]);
    expect(await allows(bob, 'project:read', F1)).to.equal(false);
    const [where] = ok(await admin.execute(olga, [{ kind: 'assignment.revokeWhere', scope: P1, subject: GROUP }]));
    expect(where.affected).to.equal(1);
    expect(await allows(carol, 'comment:create', F1)).to.equal(false);
    expect(await rolesOf(G1, user(carol))).to.deep.equal(['group.member']);

    // Project default role for org members: the org.member subject set holds a role at the project.
    const ORG_MEMBERS: AssignmentSubject = { set: { role: 'org.member', scope: O1 } };
    await admin.assign(olga, { subject: ORG_MEMBERS, role: 'viewer', scope: P1, tags: [], replaceLadder: true });
    expect(await decide(dave, 'project:read', F2)).to.deep.equal({ allowed: true, roles: { org: 'org.member', project: 'viewer' } });
    expect(await allows(mallory, 'project:read', F2)).to.equal(false);

    // Create a share link (token shown once), then revoke it.
    const expiresAt = new Date(NOW.getTime() + 7 * DAY);
    const created = await admin.createLink(olga, { scope: P1, role: 'viewer', tags: ['inspect'], expiresAt, attributes: { org_only: true } });
    expect(created.token).to.be.a('string').and.not.equal('');
    const listed = (await admin.list(olga, { kind: 'links', scope: P1 })).items as LinkDef[];
    expect(listed.map((l) => [l.id, l.attributes])).to.deep.equal([[created.link.id, { org_only: true }]]);
    expect(JSON.stringify(listed)).to.not.include(created.token);
    expect(JSON.stringify(published())).to.not.include(created.token);
    expect(JSON.stringify(session.audit!.entries)).to.not.include(created.token);
    expect(JSON.stringify((session.lane?.adminEvents as RecordingEventSink).events)).to.not.include(created.token);
    expect(await rolesOf(P1, { type: 'link', id: created.link.id })).to.deep.equal(['viewer']);
    const viaLink = linkPrincipal(created.link.id, { scope: P1, expiresAt });
    expect(await allows(viaLink, 'inspect:view', F1)).to.equal(true);
    expect(await allows(viaLink, 'file:edit', F1)).to.equal(false);
    await admin.revokeLink(olga, created.link.id);
    expect((await admin.list(olga, { kind: 'links', scope: P1 })).items).to.deep.equal([]);
    expect(await rows(P1, { type: 'link', id: created.link.id })).to.deep.equal([]);
    expect(await allows(viaLink, 'inspect:view', F1)).to.equal(false);

    // Restrict a file, and lift a restriction.
    const restrict = (file: ResourceRef): Omit<RuleDef, 'source'> => ({ id: `restrict:file:${file.id}`, kind: 'restrict', scope: file, allow: [user(alice)] });
    await admin.putRule(olga, restrict(F1));
    await admin.putRule(olga, restrict(F2));
    await admin.deleteRule(olga, 'restrict:file:f2');
    const ruleIds = async (scope: ResourceRef) => ((await admin.list(olga, { kind: 'rules', scope })).items as RuleDef[]).map((r) => r.id);
    expect(await ruleIds(F1)).to.deep.equal(['restrict:file:f1']);
    expect(await ruleIds(F2)).to.deep.equal([]);
    expect(await refused(admin.putRule(dave, restrict(F2)))).to.equal('forbidden');

    // Branch protection: two threshold rows for one pattern, written by the project maintainer.
    const branchRule = (id: string, permissions: string[], minRole: string): Omit<RuleDef, 'source'> => ({
      id,
      kind: 'threshold',
      scope: P1,
      resourceTypes: ['branch'],
      resource: { attr: 'resource.name', wildcard: 'release/*' },
      permissions,
      minRole,
      reason: { code: 'branch_protected', pattern: 'release/*', needed: minRole, priority: 700, sortKey: 'release/*' },
    });
    ok(
      await admin.execute(alice, [
        { kind: 'rule.put', rule: branchRule('branch:p1:release/*:push', ['repo:push'], 'editor') },
        { kind: 'rule.put', rule: branchRule('branch:p1:release/*:merge', ['branch:merge'], 'maintainer') },
      ]),
    );
    expect((await ruleIds(P1)).sort()).to.deep.equal(['branch:p1:release/*:merge', 'branch:p1:release/*:push']);
    await admin.deleteRule(alice, 'branch:p1:release/*:merge');
    expect(await ruleIds(P1)).to.deep.equal(['branch:p1:release/*:push']);

    // Change an org policy: scope attributes of the org, validated against the org schema.
    await admin.setScopeAttributes(olga, O1, { policies: { public_links: false } });
    expect((await admin.list(olga, { kind: 'attributes', scope: O1 })).items).to.deep.equal([{ policies: { public_links: false } }]);
    expect(published().at(-1)?.tags).to.include('scope:org:o1');
    expect(await refused(admin.setScopeAttributes(olga, O1, { policies: { public_links: 'sometimes' } }))).to.equal('invalid_attributes');
    expect(await refused(admin.setScopeAttributes(alice, O1, { policies: { viewers_may_download: false } }))).to.equal('forbidden');
    expect((await admin.list(olga, { kind: 'attributes', scope: O1 })).items).to.deep.equal([{ policies: { public_links: false } }]);

    // Delete a file and a project: one batch forgets every authz row at both nodes.
    await admin.assign(olga, { subject: user(dave), role: 'editor', scope: P2, replaceLadder: true });
    const p2Link = await admin.createLink(olga, { scope: P2, role: 'viewer' });
    await admin.putRule(olga, restrict(P2));
    await admin.assign(alice, { subject: user(bob), role: 'commenter', scope: F1 });
    const p2Viewer = linkPrincipal(p2Link.link.id, { scope: P2 });
    expect(await allows(dave, 'file:edit', P2)).to.equal(true);
    expect(await allows(p2Viewer, 'project:read', P2)).to.equal(true);
    const before = published().length;
    const [forgetF1, forgetP2] = ok(
      await admin.execute(olga, [
        { kind: 'scope.forget', scope: F1 },
        { kind: 'scope.forget', scope: P2 },
      ]),
    );
    expect(forgetF1.affected).to.equal(2);
    // dave's grant, the rule, and the link with its grant row counted once.
    expect(forgetP2.affected).to.equal(3);
    expect(published().length - before).to.equal(1);
    expect(await rows(F1)).to.deep.equal([]);
    expect(await rows(P2)).to.deep.equal([]);
    expect(await ruleIds(F1)).to.deep.equal([]);
    expect(await ruleIds(P2)).to.deep.equal([]);
    expect((await admin.list(olga, { kind: 'links', scope: P2 })).items).to.deep.equal([]);
    expect(await allows(dave, 'file:edit', P2)).to.equal(false);
    expect(await allows(p2Viewer, 'project:read', P2)).to.equal(false);
    // Rows elsewhere stay.
    expect(await rolesOf(P1, user(alice))).to.deep.equal(['maintainer']);
    expect(await ruleIds(P1)).to.deep.equal(['branch:p1:release/*:push']);
  });
});
