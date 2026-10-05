import { DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { LadderExtension, MemoryAssignmentStore, MemoryRoleStore, RBAC_STEPS, RbacModel, compileGrants, compileLadders, compileRoles, liveAssignments, roleTooLow, runRbacPipeline } from '../../src/index.js';
import type { GrantDef, LadderDef, RbacInput, RbacState, RbacStep, RbacSteps, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test', ...extra });
const at = (ms: number) => new Date(NOW.getTime() + ms);

const TYPES = ['org', 'project', 'file'];
const PERMISSIONS: PermissionInput[] = ['file:read', 'file:comment', 'file:edit', 'project:settings', 'org:audit', 'org:manage', 'file:sign'].map((name) => ({ name, types: TYPES }));

const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] },
  { name: 'org', roles: ['org.member', 'org.admin', 'org.owner'] },
];
const ROLES: RoleDef[] = [
  role('viewer', ['file:read'], { ladder: 'project' }),
  role('commenter', ['file:comment'], { ladder: 'project' }),
  role('editor', ['file:edit'], { ladder: 'project' }),
  role('maintainer', ['project:settings', 'file:sign'], { ladder: 'project' }),
  role('org.member', [], { ladder: 'org' }),
  role('org.admin', ['org:audit'], { ladder: 'org' }),
  // file:sign is on both ladders: maintainer on project, org.owner on org.
  role('org.owner', ['org:manage', 'file:sign'], { ladder: 'org' }),
  role('reader', ['file:read']),
  role('signer', [{ permission: 'file:sign', requiresTag: 'sign' }]),
];

function registry() {
  const r = new PermissionRegistryImpl();
  r.register(PERMISSIONS, 'test');
  r.freeze();
  return r;
}

const PATH = [f1, P1, O1, GLOBAL];

function input(assignments: readonly Assignment[], permission: string, opts: { resource?: ResourceRef; path?: readonly ResourceRef[]; ladders?: readonly LadderDef[]; roles?: readonly RoleDef[] } = {}): RbacInput {
  const graph = compileRoles(opts.roles ?? ROLES, opts.ladders ?? LADDERS, { extraEdges: new LadderExtension().extraEdges });
  const grants = compileGrants(graph, registry());
  return { request: { principal: alice, permission, resource: opts.resource ?? f1 }, now: NOW, path: opts.path ?? PATH, assignments, roles: graph, grants, ladders: compileLadders(graph, grants) };
}

const withSteps = (replace: Partial<RbacSteps>): RbacSteps => ({ ...RBAC_STEPS, ...replace });
/** A stand-in for task 6's cap: clamps every live and scoped assignment of `role` to `rank`. */
const clamp =
  (roleName: string, rank: number): RbacStep =>
  (s) => {
    for (const l of [...s.live, ...s.scoped]) if (l.role === roleName) l.rank = Math.min(l.rank!, rank);
  };

const tooLow = (ladder: string, roleName: string, needed: string) => ({ code: 'role_too_low', ladder, role: roleName, needed, priority: DEFAULT_DENY_PRIORITY.role_too_low });
const NO_ACCESS = { code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access };

describe('authz-rbac ladders: aggregation per ladder', () => {
  describe('ranks of live assignments', () => {
    it('collect gives each ladder assignment its rank, live and scoped alike; other roles have none', () => {
      const { live } = liveAssignments(input([assignment('a1', 'editor', P1), assignment('a2', 'reader'), assignment('a3', 'org.owner', O1)], 'file:read'));
      expect(live.map((l) => [l.role, l.rank])).to.deep.equal([
        ['editor', 2],
        ['reader', undefined],
        ['org.owner', 2],
      ]);
      const { scoped } = liveAssignments(input([assignment('a1', 'commenter', P1)], 'file:read', { resource: { type: 'file' }, path: [{ type: 'file' }, GLOBAL] }));
      expect(scoped.map((l) => [l.role, l.rank])).to.deep.equal([['commenter', 1]]);
    });

    it('without rank tables no assignment has a rank', () => {
      const { ladders: _drop, ...plain } = input([assignment('a1', 'editor')], 'file:read');
      expect(liveAssignments(plain).live[0].rank).to.equal(undefined);
    });
  });

  describe('Vote.roles: the effective role per ladder', () => {
    it('is the highest live role of each ladder; roles outside every ladder are not listed', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'editor', P1), assignment('a3', 'org.admin', O1), assignment('a4', 'reader')], 'file:read'));
      expect(vote.roles).to.deep.equal({ project: 'editor', org: 'org.admin' });
    });

    it('does not depend on assignment order', () => {
      const list = [assignment('a1', 'maintainer', P1), assignment('a2', 'viewer'), assignment('a3', 'commenter', f1)];
      expect(runRbacPipeline(input(list, 'file:read')).roles).to.deep.equal({ project: 'maintainer' });
      expect(runRbacPipeline(input([...list].reverse(), 'file:read')).roles).to.deep.equal({ project: 'maintainer' });
    });

    it('expired assignments and assignments off the path do not count', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'maintainer', GLOBAL, { expiresAt: at(-1) }), assignment('a2', 'editor', { type: 'project', id: 'p2' }), assignment('a3', 'viewer', P1)], 'file:read'));
      expect(vote.roles).to.deep.equal({ project: 'viewer' });
    });

    it("reads LiveAssignment.rank, which a cap step lowers: editor clamped to commenter loses editor's grants", () => {
      const steps = withSteps({ cap: clamp('editor', 1) });
      const edit = runRbacPipeline(input([assignment('a1', 'editor', P1)], 'file:edit'), steps);
      expect(edit.roles).to.deep.equal({ project: 'commenter' });
      expect(edit.permitWhen).to.deep.equal(FALSE);
      expect(edit.reason).to.deep.equal(tooLow('project', 'commenter', 'editor'));
      expect(runRbacPipeline(input([assignment('a1', 'editor', P1)], 'file:comment'), steps).permitWhen).to.deep.equal(TRUE);
    });

    it('a clamped assignment and an unclamped one: the highest effective rank wins', () => {
      const steps = withSteps({ cap: (s) => s.live.filter((l) => l.assignment.id === 'a1').forEach((l) => (l.rank = 0)) });
      const vote = runRbacPipeline(input([assignment('a1', 'maintainer', P1), assignment('a2', 'commenter', f1)], 'file:edit'), steps);
      expect(vote.roles).to.deep.equal({ project: 'commenter' });
      expect(vote.reason).to.deep.equal(tooLow('project', 'commenter', 'editor'));
    });
  });

  describe('state.tags', () => {
    it('is the union of the live tags', () => {
      const seen: string[][] = [];
      const steps = withSteps({ tag: (s) => void seen.push([...s.tags].sort()) });
      runRbacPipeline(input([assignment('a1', 'viewer', P1, { tags: ['inspect'] }), assignment('a2', 'reader', GLOBAL, { tags: ['code', 'inspect'] }), assignment('a3', 'editor', { type: 'project', id: 'p2' }, { tags: ['off-path'] })], 'file:read'), steps);
      expect(seen).to.deep.equal([['code', 'inspect']]);
    });
  });

  describe('validUntil from the assignments that set Vote.roles', () => {
    it('the top assignment of a ladder bounds the vote, also for a permission no role reaches', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'editor', P1, { expiresAt: at(HOUR) }), assignment('a2', 'viewer', GLOBAL, { expiresAt: at(2 * HOUR) })], 'org:audit'));
      expect(vote.roles).to.deep.equal({ project: 'editor' });
      expect(vote.validUntil).to.deep.equal(at(HOUR));
    });

    it('a lower assignment that expires does not change Vote.roles and does not bound it', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'editor', P1), assignment('a2', 'viewer', GLOBAL, { expiresAt: at(HOUR) })], 'org:audit'));
      expect(vote.validUntil).to.equal(undefined);
    });

    it('of two assignments at the top rank the role holds until the later one expires; one without expiry holds for good', () => {
      expect(runRbacPipeline(input([assignment('a1', 'editor', P1, { expiresAt: at(HOUR) }), assignment('a2', 'editor', GLOBAL, { expiresAt: at(3 * HOUR) })], 'org:audit')).validUntil).to.deep.equal(at(3 * HOUR));
      expect(runRbacPipeline(input([assignment('a1', 'editor', P1, { expiresAt: at(HOUR) }), assignment('a2', 'editor', GLOBAL)], 'org:audit')).validUntil).to.equal(undefined);
    });

    it('the earliest bound over the ladders wins', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'editor', P1, { expiresAt: at(3 * HOUR) }), assignment('a2', 'org.admin', O1, { expiresAt: at(2 * HOUR) })], 'org:manage'));
      expect(vote.validUntil).to.deep.equal(at(2 * HOUR));
    });
  });

  describe('role_too_low{ladder, role, needed} (step 5, B31)', () => {
    it('a live ladder role below the lowest role that grants the permission', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer', P1)], 'file:comment')).reason).to.deep.equal(tooLow('project', 'viewer', 'commenter'));
      expect(runRbacPipeline(input([assignment('a1', 'commenter', P1)], 'project:settings')).reason).to.deep.equal(tooLow('project', 'commenter', 'maintainer'));
    });

    it('names the effective role, the highest live one', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'commenter', f1)], 'file:edit')).reason).to.deep.equal(tooLow('project', 'commenter', 'editor'));
    });

    it('no live role on the ladder that grants the permission gives no_access', () => {
      expect(runRbacPipeline(input([], 'file:edit')).reason).to.deep.equal(NO_ACCESS);
      expect(runRbacPipeline(input([assignment('a1', 'org.admin', O1)], 'file:edit')).reason).to.deep.equal(NO_ACCESS);
      expect(runRbacPipeline(input([assignment('a1', 'reader')], 'file:edit')).reason).to.deep.equal(NO_ACCESS);
    });

    it("outside the ladder's resourceTypes no role of it would grant the permission: no_access", () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer')], 'file:edit', { resource: O1, path: [O1, GLOBAL] })).reason).to.deep.equal(NO_ACCESS);
    });

    it('several ladders: the first ladder in definition order, whatever the assignment order', () => {
      const list = [assignment('a1', 'org.admin', O1), assignment('a2', 'editor', P1)];
      expect(runRbacPipeline(input(list, 'file:sign')).reason).to.deep.equal(tooLow('project', 'editor', 'maintainer'));
      expect(runRbacPipeline(input([...list].reverse(), 'file:sign')).reason).to.deep.equal(tooLow('project', 'editor', 'maintainer'));
      const orgFirst = [LADDERS[1], LADDERS[0]];
      expect(runRbacPipeline(input(list, 'file:sign', { ladders: orgFirst })).reason).to.deep.equal(tooLow('org', 'org.admin', 'org.owner'));
    });

    const failTagged = withSteps({
      tag: (s) =>
        s.candidates
          .filter((c) => c.grant.requiresTag !== undefined)
          .forEach((c) => {
            c.failed = true;
            s.reasons.push({ code: 'tag_missing', tag: c.grant.requiresTag, priority: DEFAULT_DENY_PRIORITY.tag_missing });
          }),
    });
    const TAG_MISSING = { code: 'tag_missing', tag: 'sign', priority: DEFAULT_DENY_PRIORITY.tag_missing };

    it('a reachable grant refused by a later step reports that step, not role_too_low on a ladder below needed', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'signer'), assignment('a2', 'editor', P1)], 'file:sign'), failTagged);
      expect(vote.permitWhen).to.deep.equal(FALSE);
      expect(vote.reason).to.deep.equal(TAG_MISSING);
    });

    it('a ladder at its needed role whose grant a later step refuses: that reason, whatever another ladder holds', () => {
      const roles = [...ROLES.filter((r) => r.name !== 'maintainer'), role('maintainer', ['project:settings', { permission: 'file:sign', requiresTag: 'sign' }], { ladder: 'project' })];
      const vote = runRbacPipeline(input([assignment('a1', 'maintainer', P1), assignment('a2', 'org.admin', O1)], 'file:sign', { roles }), failTagged);
      expect(vote.roles).to.deep.equal({ project: 'maintainer', org: 'org.admin' });
      expect(vote.reason).to.deep.equal(TAG_MISSING);
    });

    it('roleTooLow: nothing when the effective role equals needed or some ladder meets it', () => {
      const at = (roles: Record<string, string>) => roleTooLow({ input: input([], 'file:sign'), permission: 'file:sign', roles } as unknown as RbacState);
      expect(at({ project: 'maintainer' })).to.equal(undefined);
      expect(at({ project: 'maintainer', org: 'org.admin' })).to.equal(undefined);
      expect(at({ project: 'editor', org: 'org.owner' })).to.equal(undefined);
      expect(at({ project: 'editor', org: 'org.admin' })).to.deep.equal(tooLow('project', 'editor', 'maintainer'));
      expect(at({ org: 'org.admin' })).to.deep.equal(tooLow('org', 'org.admin', 'org.owner'));
    });

    it('no reason while a candidate permits every row', () => {
      expect(runRbacPipeline(input([assignment('a1', 'reader'), assignment('a2', 'viewer', P1)], 'file:read')).reason).to.equal(undefined);
      expect(runRbacPipeline(input([assignment('a1', 'signer', GLOBAL, { tags: ['sign'] }), assignment('a2', 'editor', P1)], 'file:sign')).reason).to.equal(undefined);
    });
  });

  describe('type-level requests', () => {
    const typeLevel = (assignments: readonly Assignment[], permission: string, steps = RBAC_STEPS) => runRbacPipeline(input(assignments, permission, { resource: { type: 'file' }, path: [{ type: 'file' }, GLOBAL] }), steps);

    it('Vote.roles comes from GLOBAL and bare-type holders only, never from scoped ones', () => {
      expect(typeLevel([assignment('a1', 'viewer'), assignment('a2', 'maintainer', P1)], 'file:read').roles).to.deep.equal({ project: 'viewer' });
      expect(typeLevel([assignment('a1', 'commenter', { type: 'file' }), assignment('a2', 'maintainer', P1)], 'file:read').roles).to.deep.equal({ project: 'commenter' });
      expect(typeLevel([assignment('a2', 'maintainer', P1)], 'file:read').roles).to.deep.equal({});
    });

    it("a scoped holder's term follows its effective rank", () => {
      expect(typeLevel([assignment('a1', 'editor', P1)], 'file:edit').permitWhen).to.deep.equal({ op: 'under', scopes: [P1] });
      expect(typeLevel([assignment('a1', 'editor', P1)], 'file:edit', withSteps({ cap: clamp('editor', 0) })).permitWhen).to.deep.equal(FALSE);
    });
  });

  describe('through the model', () => {
    const scopes = new FakeScopeResolver({ types: TYPES, nodes: [{ ref: O1 }, { ref: P1, parent: O1 }, { ref: f1, parent: P1 }] });

    async function model(assignments: readonly Assignment[]) {
      const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore(assignments), log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      m.grantIndex();
      return m;
    }

    it('a preloaded vote equals a fresh one, Vote.roles and reason included', async () => {
      const rows = [assignment('a1', 'viewer', P1, { expiresAt: at(HOUR) }), assignment('a2', 'org.admin', O1)];
      const fresh = await (await model(rows)).evaluate({ principal: alice, permission: 'file:edit', resource: f1 }, fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] }));
      const m = await model(rows);
      const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });
      await m.preload(alice, ctx);
      const preloaded = await m.evaluate({ principal: alice, permission: 'file:edit', resource: f1 }, ctx);
      expect(preloaded).to.deep.equal(fresh);
      expect(fresh.roles).to.deep.equal({ project: 'viewer', org: 'org.admin' });
      expect(fresh.reason).to.deep.equal(tooLow('project', 'viewer', 'editor'));
      expect(fresh.validUntil).to.deep.equal(at(HOUR));
    });

    it('summarize: the roles held and only the permissions of the effective ranks', async () => {
      const m = await model([assignment('a1', 'viewer', P1), assignment('a2', 'commenter', f1)]);
      const summary = await m.summarize(alice, f1, fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] }));
      expect(summary.roles!.map((r) => r.role).sort()).to.deep.equal(['commenter', 'viewer']);
      expect(summary.permissions.map((p) => p.name)).to.deep.equal(['file:comment', 'file:read']);
    });
  });
});
