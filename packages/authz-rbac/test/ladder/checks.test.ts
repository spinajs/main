import { DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, PermissionInput, Principal, ResourceRef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, evaluateFilter, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { LadderExtension, MemoryAssignmentStore, MemoryRoleStore, PROVENANCE_RANK_PRIORITY, RBAC_STEPS, RbacModel, compileGrants, compileLadders, compileRoles, rankAt, runRbacPipeline } from '../../src/index.js';
import type { GrantDef, LadderDef, RbacInput, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const f2: ResourceRef = { type: 'file', id: 'f2' };
const alice = userPrincipal('alice');
const PW = ['project', 'org'];

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test', ...extra });

const TYPES = ['org', 'project', 'file'];
const PERMISSIONS: PermissionInput[] = ['file:read', 'inspect:view', 'repo:read', 'mr:approve', 'release:cut', 'audit:read', 'report:read'].map((name) => ({ name, types: TYPES }));
const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'] },
  { name: 'org', roles: ['org.member', 'org.admin'] },
];
const ROLES: RoleDef[] = [
  role('viewer', ['file:read', { permission: 'inspect:view', requiresTag: 'inspect' }, { permission: 'repo:read', grantedAt: PW }], { ladder: 'project' }),
  role(
    'editor',
    [
      { permission: 'mr:approve', grantedAt: PW },
      { permission: 'release:cut', requiresTag: 'beta', grantedAt: PW },
    ],
    { ladder: 'project' },
  ),
  role('maintainer', [], { ladder: 'project' }),
  role('org.member', [], { ladder: 'org' }),
  role('org.admin', [{ permission: 'audit:read', grantedAt: ['org'] }], { ladder: 'org', implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect'] }] }),
  // Outside every ladder: provenance counts the assignments that reach the grant.
  role('auditor', [{ permission: 'report:read', grantedAt: ['project'] }]),
];

function registry() {
  const r = new PermissionRegistryImpl();
  r.register(PERMISSIONS, 'test');
  r.freeze();
  return r;
}

function input(assignments: readonly Assignment[], permission: string, path: readonly ResourceRef[] = [f1, P1, O1, GLOBAL], roles: readonly RoleDef[] = ROLES): RbacInput {
  const graph = compileRoles(roles, LADDERS, { extraEdges: new LadderExtension().extraEdges });
  const grants = compileGrants(graph, registry());
  return { request: { principal: alice, permission, resource: path[0] }, now: NOW, path, assignments, roles: graph, grants, ladders: compileLadders(graph, grants) };
}

const TAG_MISSING = (tag: string) => ({ code: 'tag_missing', tag, priority: DEFAULT_DENY_PRIORITY.tag_missing });
const PROVENANCE = (needed: readonly string[] = PW) => ({ code: 'provenance', needed, priority: DEFAULT_DENY_PRIORITY.provenance });
const RANK_LOW = (roleName: string, needed: string, ladder = 'project') => ({ code: 'role_too_low', ladder, role: roleName, needed, priority: PROVENANCE_RANK_PRIORITY });

const scopes = new FakeScopeResolver({ types: TYPES, nodes: [{ ref: O1 }, { ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: f1, parent: P1 }, { ref: f2, parent: P2 }] });
const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

async function model(rows: readonly Assignment[]) {
  const base = { roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore(rows) };
  const m = new RbacModel({ ...base, log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  m.grantIndex();
  return m;
}
const vote = (m: RbacModel, permission: string, resource: ResourceRef, principal: Principal = alice): Promise<Vote> => Promise.resolve(m.evaluate({ principal, permission, resource }, ctx()));

describe('authz-rbac tags and provenance (B34)', () => {
  describe('requiresTag (step 6)', () => {
    it('passes when the tag union of the live assignments holds it, from any of them', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'org.member', O1, { tags: ['inspect'] })], 'inspect:view')).permitWhen).to.deep.equal(TRUE);
    });

    it('denies tag_missing{tag} (420) when no live assignment carries it; off-path and expired carriers do not count', () => {
      const v = runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'viewer', P2, { tags: ['inspect'] }), assignment('a3', 'viewer', O1, { tags: ['inspect'], expiresAt: NOW })], 'inspect:view'));
      expect(v.permitWhen).to.deep.equal(FALSE);
      expect(v.reason).to.deep.equal(TAG_MISSING('inspect'));
    });

    it('an implied role carries the tags implies declares', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      expect((await vote(m, 'inspect:view', f1)).permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment made to a set carries its own tags', async () => {
      const rows: Assignment[] = [assignment('m1', 'org.member', O1), { id: 's1', subject: { set: { role: 'org.member', scope: O1 } } as AssignmentSubject, role: 'viewer', scope: P1, tags: ['inspect'], source: 'test' }];
      const m = new RbacModel({ roles: new MemoryRoleStore([...ROLES.filter((r) => r.name !== 'org.member'), role('org.member', [], { ladder: 'org', subjectSet: true })], LADDERS), assignments: new MemoryAssignmentStore(rows), log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      expect((await vote(m, 'inspect:view', f1)).permitWhen).to.deep.equal(TRUE);
    });

    it('the carrier that keeps the tag bounds validUntil, also when nothing else would', () => {
      // auditor is on no ladder and reaches no grant of inspect:view: only the tag check reads it.
      const v = runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'auditor', O1, { tags: ['inspect'], expiresAt: later(HOUR) })], 'inspect:view'));
      expect(v.permitWhen).to.deep.equal(TRUE);
      expect(v.validUntil).to.deep.equal(later(HOUR));
    });

    it('on a type-level request a scoped carrier bounds validUntil too', async () => {
      const m = await model([assignment('a1', 'viewer', P2), assignment('a2', 'auditor', P1, { tags: ['inspect'], expiresAt: later(HOUR) })]);
      expect((await vote(m, 'inspect:view', { type: 'file' })).validUntil).to.deep.equal(later(HOUR));
    });
  });

  describe('grantedAt (step 7)', () => {
    it('no assignment of the ladder made at those types: provenance{needed} (430)', () => {
      const v = runRbacPipeline(input([assignment('a1', 'editor', f1), assignment('a2', 'org.member', O1)], 'repo:read'));
      expect(v.permitWhen).to.deep.equal(FALSE);
      expect(v.reason).to.deep.equal(PROVENANCE());
    });

    it('the rank of the assignments made there decides; below the declaring role: role_too_low on that rank (440)', () => {
      const v = runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'editor', f1)], 'mr:approve'));
      expect(v.reason).to.deep.equal(RANK_LOW('viewer', 'editor'));
      expect(runRbacPipeline(input([assignment('a1', 'editor', P1)], 'mr:approve')).permitWhen).to.deep.equal(TRUE);
    });

    it('an implied role counts as made at the implying scope (org admin ⇒ maintainer, project-derived)', async () => {
      const m = await model([assignment('a1', 'org.admin', O1)]);
      expect((await vote(m, 'mr:approve', f1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'audit:read', f1)).permitWhen).to.deep.equal(TRUE);
    });

    it('a grant outside every ladder counts the assignments that reach it', () => {
      expect(runRbacPipeline(input([assignment('a1', 'auditor', P1)], 'report:read')).permitWhen).to.deep.equal(TRUE);
      const v = runRbacPipeline(input([assignment('a1', 'auditor', f1), assignment('a2', 'viewer', P1)], 'report:read'));
      expect(v.reason).to.deep.equal(PROVENANCE(['project']));
    });

    it('the assignments made there bound validUntil', () => {
      const v = runRbacPipeline(input([assignment('a1', 'editor', P1, { expiresAt: later(2 * HOUR) }), assignment('a2', 'editor', f1, { expiresAt: later(HOUR) })], 'mr:approve'));
      expect(v.permitWhen).to.deep.equal(TRUE);
      expect(v.validUntil).to.deep.equal(later(HOUR));
    });

    it('rankAt is kept on the state for the threshold step', () => {
      const seen: (number | undefined)[] = [];
      runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'editor', f1)], 'mr:approve'), { ...RBAC_STEPS, threshold: (s) => void seen.push(rankAt(s, 'project', PW), rankAt(s, 'project', ['file']), rankAt(s, 'org', PW)) });
      expect(seen).to.deep.equal([0, 1, undefined]);
    });
  });

  describe('order and reasons (D17)', () => {
    it('does not depend on grant order: two grants of one permission missing different tags', () => {
      const a = role('tagged.a', [{ permission: 'report:read', requiresTag: 'a' }]);
      const b = role('tagged.b', [{ permission: 'report:read', requiresTag: 'b' }]);
      const rows = [assignment('a1', 'tagged.a', P1), assignment('a2', 'tagged.b', P1)];
      const forward = runRbacPipeline(input(rows, 'report:read', undefined, [...ROLES, a, b]));
      const backward = runRbacPipeline(input([...rows].reverse(), 'report:read', undefined, [...ROLES, b, a]));
      expect(forward.reason).to.deep.equal(TAG_MISSING('a'));
      expect(backward.reason).to.deep.equal(TAG_MISSING('a'));
    });

    it('role first, then tag, provenance, provenance rank; the lowest priority wins whatever fails', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer', P1)], 'release:cut')).reason).to.include({ code: 'role_too_low', priority: DEFAULT_DENY_PRIORITY.role_too_low });
      expect(runRbacPipeline(input([assignment('a1', 'editor', f1)], 'release:cut')).reason).to.deep.equal(TAG_MISSING('beta'));
      expect(runRbacPipeline(input([assignment('a1', 'editor', f1, { tags: ['beta'] })], 'release:cut')).reason).to.deep.equal(PROVENANCE());
      expect(runRbacPipeline(input([assignment('a1', 'viewer', P1), assignment('a2', 'editor', f1, { tags: ['beta'] })], 'release:cut')).reason).to.deep.equal(RANK_LOW('viewer', 'editor'));
    });

    it('does not depend on assignment order', () => {
      const rows = [assignment('a1', 'viewer', P1), assignment('a2', 'editor', f1, { tags: ['beta'] }), assignment('a3', 'org.admin', O1)];
      const forward = runRbacPipeline(input(rows, 'release:cut'));
      const backward = runRbacPipeline(input([...rows].reverse(), 'release:cut'));
      expect(forward.reason).to.deep.equal(backward.reason);
      expect(forward.permitWhen).to.deep.equal(backward.permitWhen);
    });
  });

  describe('type-level requests (B06)', () => {
    const FILE = { type: 'file' };

    it('a live grant whose tag only scoped assignments carry permits the rows below them', async () => {
      const m = await model([assignment('a1', 'viewer'), assignment('a2', 'org.member', P1, { tags: ['inspect'] })]);
      expect((await vote(m, 'inspect:view', FILE)).permitWhen).to.deep.equal({ op: 'under', scopes: [P1] });
    });

    it("a scoped holder's grant carries its tag and provenance parts in its row term", async () => {
      const m = await model([assignment('a1', 'viewer', P2), assignment('a2', 'org.member', P1, { tags: ['inspect'] })]);
      expect((await vote(m, 'inspect:view', FILE)).permitWhen).to.deep.equal({
        op: 'and',
        args: [
          { op: 'under', scopes: [P2] },
          { op: 'under', scopes: [P1] },
        ],
      });
      const pw = await model([assignment('a1', 'editor', f2), assignment('a2', 'editor', P1)]);
      expect((await vote(pw, 'mr:approve', FILE)).permitWhen).to.deep.equal({
        op: 'and',
        args: [
          { op: 'under', scopes: [f2, P1] },
          { op: 'under', scopes: [P1] },
        ],
      });
    });

    it('every row the filter selects is a row the check allows, and the reverse', async () => {
      const rows = [assignment('a1', 'viewer'), assignment('a2', 'org.member', P1, { tags: ['inspect'] }), assignment('a3', 'editor', f2), assignment('a4', 'viewer', P2)];
      const m = await model(rows);
      for (const permission of ['inspect:view', 'mr:approve', 'repo:read']) {
        const filter = (await vote(m, permission, FILE)).permitWhen;
        for (const ref of [f1, f2]) {
          const listed = (await evaluateFilter(filter, { id: ref.id }, { principal: alice, ref, context: ctx() })) === true;
          const checked = (await vote(m, permission, ref)).permitWhen.op === 'true';
          expect(listed, `${permission} ${ref.id}`).to.equal(checked);
        }
      }
    });
  });

  describe('summarize', () => {
    it('leaves out a permission whose tag or provenance the principal lacks, and lists one some rows pass as conditional', async () => {
      const lacking = await model([assignment('a1', 'editor', f1)]);
      expect((await lacking.summarize(alice, f1, ctx())).permissions.map((p) => p.name)).to.deep.equal(['file:read']);
      const some = await model([assignment('a1', 'viewer'), assignment('a2', 'org.member', P1, { tags: ['inspect'] })]);
      const summary = await some.summarize(alice, GLOBAL, ctx());
      expect(summary.permissions.find((p) => p.name === 'inspect:view')).to.deep.equal({ name: 'inspect:view', conditional: true });
    });
  });
});
