import { AuthzConfigError, DefaultConditionCompiler, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, PermissionInput, Principal, ResourceRef, RuleDef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, evaluateFilter, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel, RbacService, RuleRowsError } from '../../src/index.js';
import type { GrantDef, LadderDef, RoleDef, RuleStore } from '../../src/index.js';
import { CANVAS_RULES } from './canvas-rules.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const O1: ResourceRef = { type: 'org', id: 'o1' };
const O2: ResourceRef = { type: 'org', id: 'o2' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const f2: ResourceRef = { type: 'file', id: 'f2' };
const G1: ResourceRef = { type: 'group', id: 'g1' };
const P3: ResourceRef = { type: 'project', id: 'p3' };
const f3: ResourceRef = { type: 'file', id: 'f3' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test', ...extra });
const rule = (def: Omit<RuleDef, 'source'>): RuleDef => ({ ...def, source: 'test' });

const TYPES = ['org', 'project', 'file', 'group'];
const PERMISSIONS: PermissionInput[] = ['file:read', 'file:edit', 'file:admin', 'org:audit', 'inspect:view'].map((name) => ({ name, types: TYPES }));
const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'] },
  { name: 'org', roles: ['org.guest', 'org.member', 'org.admin', 'org.owner'] },
];
const ROLES: RoleDef[] = [role('viewer', ['file:read', { permission: 'inspect:view', requiresTag: 'inspect' }], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['file:admin'], { ladder: 'project' }), role('org.guest', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org', subjectSet: true }), role('org.admin', ['org:audit'], { ladder: 'org', implies: [{ role: 'maintainer', at: 'self-and-descendants' }] }), role('org.owner', [], { ladder: 'org' }), role('group.member', [], { subjectSet: true }), role('lead', [], { implies: [{ role: 'editor', at: 'self-and-descendants', bypass: ['cap'] }] })];

function registry() {
  const r = new PermissionRegistryImpl();
  r.register(PERMISSIONS, 'test');
  r.freeze();
  return r;
}

const scopes = new FakeScopeResolver({
  types: TYPES,
  nodes: [{ ref: O1, attributes: { policies: { max_role: 'viewer', locked: true } } }, { ref: O2, attributes: { policies: {} } }, { ref: P1, parent: O1 }, { ref: P2, parent: O2 }, { ref: f1, parent: P1 }, { ref: f2, parent: P2 }, { ref: G1 }, { ref: P3 }, { ref: f3, parent: P3 }],
});
const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes], conditions: new DefaultConditionCompiler(undefined, [scopes]) });

async function model(rows: readonly Assignment[], rules: readonly Omit<RuleDef, 'source'>[], roles: readonly RoleDef[] = ROLES) {
  const m = new RbacModel({ roles: new MemoryRoleStore(roles, LADDERS), assignments: new MemoryAssignmentStore(rows), rules: new ConfigRuleStore(rules.map(rule)), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  m.grantIndex();
  return m;
}
const vote = (m: RbacModel, permission: string, resource: ResourceRef, principal: Principal = alice): Promise<Vote> => Promise.resolve(m.evaluate({ principal, permission, resource }, ctx()));
async function rejects(p: Promise<unknown>, part: string | (new (...a: never[]) => Error)): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  if (typeof part === 'string') expect((thrown as Error | undefined)?.message).to.contain(part);
  else expect(thrown).to.be.instanceOf(part);
}

describe('authz-rbac rules (B35)', () => {
  describe('boot (design §6.5 rules 7, 9, 10)', () => {
    const boot = (rules: readonly Omit<RuleDef, 'source'>[]) => model([], rules);

    it('refuses an unknown ladder or role, a role of another ladder, a role on no ladder, and a ref of the wrong form', async () => {
      await rejects(boot([{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'ghost', maxRole: 'viewer' }]), "unknown ladder 'ghost'");
      await rejects(boot([{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'phantom' }]), "unknown role 'phantom'");
      await rejects(boot([{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'org.guest' }]), "not of ladder 'project'");
      await rejects(boot([{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'group.member' }]), 'on no ladder');
      await rejects(boot([{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'org', at: 'org', lt: 'viewer' } } }]), 'subjects.rank.lt');
      await rejects(boot([{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'org.max' } }]), 'not a ref');
      await rejects(boot([{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'viewer', when: { attr: 'galaxy.x', eq: 1 } }]), "rbac rule 't'");
    });

    it('feeds literal permissions and the scope types a rule reads to the boot checks', async () => {
      const m = await boot([
        { id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read', 'file:*'], ladder: 'org', at: 'org', minRole: 'org.member', when: { attr: 'scope.group.open', eq: true } },
        { id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.project.max' } },
      ]);
      const out = await new RbacContributor(m).contribute('test');
      expect(out.permissionRefs).to.deep.include({ permission: 'file:read', source: "rbac rule 't'" });
      expect(out.scopeRefs).to.deep.equal([
        { type: 'org', source: "rbac rule 't'" },
        { type: 'group', source: "rbac rule 't'" },
        { type: 'project', source: "rbac rule 'c'" },
      ]);
    });
  });

  describe('restrict (step 2)', () => {
    it('keeps assignments at or below its node, allowed subjects (sets too), and bypass contributions', async () => {
      const set: AssignmentSubject = { set: { role: 'org.member', scope: O1 } };
      const rows = [assignment('a1', 'viewer', O1), assignment('a2', 'editor', f1), { id: 's1', subject: set, role: 'maintainer', scope: O1, source: 'test' }, assignment('m1', 'org.member', O1)];
      const m = await model(rows, [{ id: 'r', kind: 'restrict', scope: P1, allow: [set] }]);
      const roles = (await new RbacService(m).rolesOf(alice, f1, { ctx: ctx() })).map((r) => r.assignment).sort();
      expect(roles).to.deep.equal(['a2', 's1']);
    });
  });

  describe('cap (step 3)', () => {
    it('clamps to the lowest matching cap; Vote.roles, rolesOf and summarize show the effective role', async () => {
      const m = await model(
        [assignment('a1', 'maintainer', P1)],
        [
          { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'editor' },
          { id: 'c2', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' },
        ],
      );
      const v = await vote(m, 'file:edit', f1);
      expect(v.roles).to.deep.equal({ project: 'viewer' });
      expect(v.permitWhen).to.deep.equal(FALSE);
      const [held] = await new RbacService(m).rolesOf(alice, f1, { ctx: ctx() });
      expect(held).to.include({ role: 'maintainer', effectiveRole: 'viewer' });
      expect((await m.summarize(alice, f1, ctx())).roles!.map((r) => r.role)).to.deep.equal(['viewer']);
      expect(await new RbacService(m).coversAt(alice, ['editor'], f1, ctx())).to.equal(false);
    });

    it('a set subject counts as the type of its scope for assignments.subjectTypes', async () => {
      const set: AssignmentSubject = { set: { role: 'group.member', scope: G1 } };
      const m = await model([assignment('x1', 'group.member', G1), { id: 's1', subject: set, role: 'editor', scope: P1, source: 'test' }], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: null, assignments: { subjectTypes: ['group'] } }]);
      expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(FALSE);
    });

    it('capping an implying role drops what it no longer implies; bypass cap keeps the contribution', async () => {
      const capOrg = { id: 'c', kind: 'cap' as const, scope: GLOBAL, ladder: 'org', maxRole: 'org.member' };
      const owner = await model([assignment('a1', 'org.owner', O1)], [capOrg]);
      expect((await vote(owner, 'file:admin', f1)).permitWhen).to.deep.equal(FALSE);
      const lead = await model([assignment('a1', 'lead', O1)], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer' }]);
      expect((await vote(lead, 'file:edit', f1)).permitWhen).to.deep.equal(TRUE);
    });

    it('subjects.rank reads the ranks before any cap, so caps do not depend on each other', async () => {
      const rules = [
        { id: 'a-org', kind: 'cap' as const, scope: GLOBAL, ladder: 'org', maxRole: 'org.guest' },
        { id: 'b-project', kind: 'cap' as const, scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'org', at: 'org', lt: 'org.member' } } },
      ];
      const m = await model([assignment('a1', 'org.member', O1), assignment('a2', 'editor', P1)], rules);
      expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(TRUE);
    });

    it('a ref resolves per request; a missing value is indeterminate; null drops', async () => {
      const m = await model([assignment('a1', 'editor', GLOBAL)], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } }]);
      expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(FALSE);
      await rejects(vote(m, 'file:edit', f2), 'B39');
      const nulls = await model([assignment('a1', 'editor', GLOBAL)], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'principal.attributes.max' } }]);
      expect((await vote(nulls, 'file:edit', f1, userPrincipal('alice', { attributes: { max: null } }))).permitWhen).to.deep.equal(FALSE);
      await rejects(vote(nulls, 'file:edit', f1, userPrincipal('alice', { attributes: { max: 'org.guest' } })), "no role of ladder 'project'");
    });

    it('a rule that reads scope.org is skipped on $global; a missing attribute of an org is indeterminate', async () => {
      const m = await model([assignment('a1', 'editor', GLOBAL)], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'scope.org.policies.locked', eq: true } }]);
      expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'file:edit', GLOBAL)).permitWhen).to.deep.equal(TRUE);
      await rejects(vote(m, 'file:edit', f2), 'scope.org.policies.locked');
    });
  });

  describe('threshold (step 8)', () => {
    const exportRule = { id: 't', kind: 'threshold' as const, scope: GLOBAL, permissions: ['file:read'], minRole: 'editor', reason: { code: 'policy' } };

    it('a deny entry with the rule reason (default priority 600) where the rank is below minRole', async () => {
      const m = await model([assignment('a1', 'viewer', P1)], [exportRule]);
      const v = await vote(m, 'file:read', f1);
      expect(v.permitWhen).to.deep.equal(TRUE);
      expect(v.denies).to.deep.equal([{ when: TRUE, reason: { code: 'policy', priority: 600 } }]);
      const bare = await model([assignment('a1', 'viewer', P1)], [{ ...exportRule, reason: undefined }]);
      expect((await vote(bare, 'file:read', f1)).denies![0].reason).to.deep.equal({ code: 'threshold', rule: 't', priority: 600 });
    });

    it('on a type-level request the entry denies the rows no assignment with enough rank reaches', async () => {
      const m = await model([assignment('a1', 'viewer'), assignment('a2', 'editor', P1)], [exportRule]);
      const v = await vote(m, 'file:read', { type: 'file' });
      expect(v.denyWhen).to.deep.equal({ op: 'not', arg: { op: 'under', scopes: [P1] } });
      for (const ref of [f1, f2]) {
        const check = await vote(m, 'file:read', ref);
        const allowed = check.permitWhen.op === 'true' && check.denyWhen.op === 'false';
        const listed = (await evaluateFilter({ op: 'and', args: [v.permitWhen, { op: 'not', arg: v.denyWhen }] }, { id: ref.id }, { principal: alice, ref, context: ctx() })) === true;
        expect(listed, ref.id).to.equal(allowed);
      }
    });

    it('the rule expiry bounds validUntil', async () => {
      const m = await model([assignment('a1', 'viewer', P1)], [{ ...exportRule, expiresAt: new Date(NOW.getTime() + HOUR) }]);
      expect((await vote(m, 'file:read', f1)).validUntil).to.deep.equal(new Date(NOW.getTime() + HOUR));
    });
  });

  describe('type-level requests fail closed where rules would differ per row', () => {
    it('a rule off the path, a scope ref or a rank selector: RuleRowsError; summarize lists the permissions as conditional', async () => {
      const elsewhere = await model([assignment('a1', 'editor', P1)], [{ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' }]);
      await rejects(vote(elsewhere, 'file:edit', { type: 'file' }), RuleRowsError);
      const refs = await model([assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } }]);
      await rejects(vote(refs, 'file:edit', { type: 'file' }), RuleRowsError);
      const summary = await refs.summarize(alice, GLOBAL, ctx());
      expect(summary.permissions.find((p) => p.name === 'file:edit')).to.deep.equal({ name: 'file:edit', conditional: true });
    });

    it('a cap at GLOBAL with constant parts applies to every row alike', async () => {
      const m = await model([assignment('a1', 'editor', P1)], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer' }]);
      expect((await vote(m, 'file:edit', { type: 'file' })).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'file:read', { type: 'file' })).permitWhen).to.deep.equal({ op: 'under', scopes: [P1] });
    });
  });

  describe('UNKNOWN conditions, covers and indeterminate rules', () => {
    const capOf = (extra: Partial<RuleDef>): Omit<RuleDef, 'source'> => ({ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', ...extra });
    const notVerified = { not: { attr: 'principal.attributes.verified', eq: true } };
    const who = (attributes: Record<string, unknown>) => userPrincipal('alice', { attributes });

    it('a cap or restrict condition that is UNKNOWN applies the rule; only a definite false keeps it off', async () => {
      for (const extra of [{ subjects: { when: notVerified } }, { when: notVerified }]) {
        const m = await model([assignment('a1', 'editor', P1)], [capOf(extra)]);
        expect((await vote(m, 'file:edit', f1, who({}))).permitWhen, 'missing').to.deep.equal(FALSE);
        expect((await vote(m, 'file:edit', f1, who({ verified: false }))).permitWhen, 'false').to.deep.equal(FALSE);
        expect((await vote(m, 'file:edit', f1, who({ verified: true }))).permitWhen, 'true').to.deep.equal(TRUE);
      }
      const restrict = await model([assignment('a1', 'editor', P1)], [{ id: 'r', kind: 'restrict', scope: f1, allow: [], when: notVerified }]);
      expect((await vote(restrict, 'file:edit', f1, who({}))).permitWhen).to.deep.equal(FALSE);
      expect((await vote(restrict, 'file:edit', f1, who({ verified: true }))).permitWhen).to.deep.equal(TRUE);
    });

    it('a threshold keeps an UNKNOWN subjects.when or when in its deny entry, also next to a scope attribute', async () => {
      const linkLike: Omit<RuleDef, 'source'> = {
        id: 't',
        kind: 'threshold',
        scope: GLOBAL,
        permissions: ['file:read'],
        ladder: 'org',
        at: 'org',
        minRole: 'org.guest',
        when: {
          any: [
            { attr: 'principal.attributes.org_only', eq: true },
            { attr: 'scope.org.policies.locked', eq: false },
          ],
        },
        reason: { code: 'link_invalid', priority: 300 },
      };
      const m = await model([assignment('a1', 'viewer', P1)], [linkLike]);
      const unknown = await vote(m, 'file:read', f1, who({}));
      expect(unknown.denies).to.have.length(1);
      expect(JSON.stringify(unknown.denies![0].when)).to.contain('$unknown');
      expect((await vote(m, 'file:read', f1, who({ org_only: false }))).denies).to.equal(undefined);
      const bySubjects = await model([assignment('a1', 'viewer', P1)], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'editor', subjects: { when: notVerified } }]);
      expect(JSON.stringify((await vote(bySubjects, 'file:read', f1, who({}))).denies![0].when)).to.contain('$unknown');
      expect((await vote(bySubjects, 'file:read', f1, who({ verified: true }))).denies).to.equal(undefined);
    });

    it('covers of a principal at a resource refuses when rules exist; coversAt sees the cap', async () => {
      const m = await model([assignment('a1', 'editor')], [capOf({ scope: O1 })]);
      await m.preload(alice, ctx());
      const service = new RbacService(m);
      expect(() => service.covers(alice, ['editor'], f1)).to.throw(AuthzConfigError, 'coversAt');
      expect(await service.coversAt(alice, ['editor'], f1, ctx())).to.equal(false);
      expect(service.covers(alice, ['editor'])).to.equal(true);
    });

    it('a rule store that is not in memory makes type-level requests fail closed', async () => {
      const inner = new ConfigRuleStore([rule(capOf({ scope: O1 }))]);
      const remote: RuleStore = { name: 'remote', forPath: (path, at) => inner.forPath(path, at), version: () => inner.version() };
      const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore([assignment('a1', 'editor')]), rules: remote, log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      await rejects(vote(m, 'file:edit', { type: 'file' }), RuleRowsError);
      expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(FALSE);
      expect((await m.summarize(alice, GLOBAL, ctx())).permissions.find((p) => p.name === 'file:edit')).to.deep.equal({ name: 'file:edit', conditional: true });
    });

    it('a role on no ladder that extends a ladder role above the cap is dropped, as is any under maxRole null', async () => {
      const roles = [...ROLES, role('boss', [], { extends: ['maintainer'] })];
      const capped = await model([assignment('a1', 'boss', P1)], [capOf({})], roles);
      expect((await vote(capped, 'file:admin', f1)).permitWhen).to.deep.equal(FALSE);
      expect((await vote(capped, 'file:read', f1)).permitWhen).to.deep.equal(FALSE);
      const loose = await model([assignment('a1', 'boss', P1)], [capOf({ maxRole: 'maintainer' })], roles);
      expect((await vote(loose, 'file:admin', f1)).permitWhen).to.deep.equal(TRUE);
      const dropped = await model([assignment('a1', 'boss', P1)], [capOf({ maxRole: null })], roles);
      expect((await vote(dropped, 'file:read', f1)).permitWhen).to.deep.equal(FALSE);
    });

    it('a rule reading scope.org is indeterminate on a resource without an org above it, and skipped only on $global', async () => {
      const m = await model([assignment('a1', 'editor')], [capOf({ when: { attr: 'scope.org.policies.locked', eq: true } })]);
      await rejects(vote(m, 'file:edit', f3), 'no org ancestor');
      expect((await vote(m, 'file:edit', GLOBAL)).permitWhen).to.deep.equal(TRUE);
    });

    it('a ref the decision cache key does not hold makes the vote uncacheable', async () => {
      const byEnv = await model([assignment('a1', 'editor', P1)], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: { ref: 'env.required_role' } }]);
      const v = await Promise.resolve(byEnv.evaluate({ principal: alice, permission: 'file:read', resource: f1, env: { required_role: 'maintainer' } }, ctx()));
      expect(v.cacheable).to.equal(false);
      expect(v.denies).to.have.length(1);
      const byAttribute = await model([assignment('a1', 'editor', P1)], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: { ref: 'principal.attributes.min' } }]);
      expect((await vote(byAttribute, 'file:read', f1, who({ min: 'viewer' }))).cacheable).to.equal(true);
    });

    it('a condition over resource.* that no vote can follow per row is refused at boot', async () => {
      const wild = { attr: 'resource.name', wildcard: 'release/*' };
      const x = { attr: 'principal.attributes.x', eq: true };
      await rejects(model([assignment('a1', 'editor')], [capOf({ when: { attr: 'resource.name', eq: 'x' } })]), 'its when reads resource.*, which a cap rule cannot follow per row');
      await rejects(model([], [{ id: 'r', kind: 'restrict', scope: O1, allow: [], when: { not: wild } }]), 'which a restrict rule cannot follow per row');
      await rejects(model([], [capOf({ maxRole: { ref: 'scope.org.max' }, when: x, subjects: { when: { any: [x, wild] } } })]), 'subjects.when reads resource.*');
      await rejects(model([], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'maintainer', subjects: { when: wild } }]), 'subjects.when reads resource.*');
      // A threshold follows resource.* per row, in when and in resource.
      await model([], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'maintainer', when: wild, resource: wild }]);
    });

    it('a stored rule the config schema would refuse fails the check with a named error', async () => {
      const cases: [Omit<RuleDef, 'source'>, string][] = [
        [capOf({ resource: { attr: 'resource.name', eq: 'x' } }), 'resource belongs to a threshold'],
        [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'] } as Omit<RuleDef, 'source'>, 'a threshold needs minRole'],
        [{ id: 'c', kind: 'cap', scope: GLOBAL, maxRole: 'viewer' }, 'a cap with maxRole needs the ladder'],
      ];
      for (const [def, message] of cases) {
        // Not a ConfigRuleStore, which refuses the rule when it reads it.
        const store: RuleStore = { name: 'remote', forPath: async () => [{ ...def, source: 'db' }], version: async () => '1' };
        const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore([assignment('a1', 'editor')]), rules: store, log: { warn: () => undefined } });
        await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
        await rejects(vote(m, 'file:edit', f1), message);
      }
    });
  });

  describe('rules where a scope node is missing, covers and caps', () => {
    const capOf = (extra: Partial<RuleDef>): Omit<RuleDef, 'source'> => ({ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', ...extra });
    const CANVAS_PERMISSIONS: PermissionInput[] = [...['file:read', 'file:edit', 'project:export', 'repo:read', 'grants:invite', 'project:delete'].map((name) => ({ name, types: ['org', 'project', 'file'] })), { name: 'user:read', types: ['user'] }, { name: 'fs:read', types: ['dir'] }];
    const CANVAS_LADDERS: LadderDef[] = [
      { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'] },
      { name: 'org', roles: ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'] },
    ];
    const CANVAS_ROLES = [role('viewer', ['file:read', 'project:export', 'repo:read'], { ladder: 'project' }), role('commenter', [], { ladder: 'project' }), role('editor', ['file:edit', 'grants:invite'], { ladder: 'project' }), role('maintainer', ['project:delete'], { ladder: 'project' }), ...['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'].map((name) => role(name, [], { ladder: 'org' })), role('user', ['user:read', 'fs:read'])];
    const U: ResourceRef = { type: 'user', id: 'alice' };
    const D1: ResourceRef = { type: 'dir', id: 'd1' };

    async function canvas(rows: readonly Assignment[]) {
      const registry = new PermissionRegistryImpl();
      registry.register(CANVAS_PERMISSIONS, 'test');
      registry.freeze();
      const m = new RbacModel({ roles: new MemoryRoleStore(CANVAS_ROLES, CANVAS_LADDERS), assignments: new MemoryAssignmentStore(rows), rules: new ConfigRuleStore(CANVAS_RULES as RuleDef[]), log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
      m.grantIndex();
      return m;
    }

    it('under the §8.5 rules, checks outside every org answer when no rule could act there', async () => {
      const m = await canvas([assignment('a1', 'user')]);
      expect((await vote(m, 'user:read', U)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'fs:read', D1)).permitWhen).to.deep.equal(TRUE);
      expect(await new RbacService(m).coversAt(alice, ['user'], U, ctx())).to.equal(true);
    });

    it('a rule that could act on a resource without its scope node still fails closed (B39)', async () => {
      const m = await canvas([assignment('a1', 'editor', P3)]);
      await rejects(vote(m, 'file:edit', f3), 'no org ancestor');
      const restrict = await model([assignment('a1', 'editor')], [{ id: 'r', kind: 'restrict', scope: P3, allow: [], when: { attr: 'scope.org.policies.locked', eq: true } }]);
      await rejects(vote(restrict, 'file:edit', f3), 'no org ancestor');
      const kept = await model([assignment('a1', 'editor', f3)], [{ id: 'r', kind: 'restrict', scope: P3, allow: [], when: { attr: 'scope.org.policies.locked', eq: true } }]);
      expect((await vote(kept, 'file:edit', f3)).permitWhen).to.deep.equal(TRUE);
      const threshold = await model([assignment('a1', 'viewer')], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'editor', when: { attr: 'scope.org.policies.locked', eq: true } }]);
      await rejects(vote(threshold, 'file:read', f3), 'no org ancestor');
      const met = await model([assignment('a1', 'editor')], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'editor', when: { attr: 'scope.org.policies.locked', eq: true } }]);
      expect((await vote(met, 'file:read', f3)).denies).to.equal(undefined);
    });

    it('an in-memory store without a live rule keeps the synchronous covers at a resource', async () => {
      const m = await model([assignment('a1', 'editor')], [capOf({ scope: O1, expiresAt: new Date(NOW.getTime() - 1) })]);
      await m.preload(alice, ctx());
      expect(new RbacService(m).covers(alice, ['editor'], f1)).to.equal(true);
      const live = await model([assignment('a1', 'editor')], [capOf({ scope: O1 })]);
      await live.preload(alice, ctx());
      expect(() => new RbacService(live).covers(alice, ['editor'], { type: 'file' })).to.throw(AuthzConfigError, 'coversAt');
    });

    it('a rule whose condition is a definite false does not read its maxRole or minRole ref', async () => {
      const notX = { attr: 'principal.attributes.x', eq: true };
      const who = (attributes: Record<string, unknown>) => userPrincipal('alice', { attributes });
      const off = who({ x: false });
      const threshold = await model([assignment('a1', 'editor', P1)], [{ id: 't', kind: 'threshold', scope: O1, permissions: ['file:edit'], when: notX, minRole: { ref: 'principal.attributes.min' } }]);
      expect((await vote(threshold, 'file:edit', f1, off)).permitWhen).to.deep.equal(TRUE);
      await rejects(vote(threshold, 'file:edit', f1, who({ x: true })), 'has no value');
      const capped = await model([assignment('a1', 'editor', P1)], [capOf({ scope: O1, when: notX, maxRole: { ref: 'principal.attributes.max' } })]);
      expect((await vote(capped, 'file:edit', f1, off)).permitWhen).to.deep.equal(TRUE);
      await rejects(vote(capped, 'file:edit', f1, who({ x: true })), 'has no value');
    });

    it('covers judges rule expiry at the request time, as the read itself does', async () => {
      // The model clock is the system clock, days after NOW: the rule has expired there but is live at ctx.now.
      const m = await model([assignment('a1', 'editor')], [capOf({ scope: O1, expiresAt: new Date(NOW.getTime() + HOUR) })]);
      const c = ctx();
      await m.preload(alice, c);
      expect(() => new RbacService(m).covers(alice, ['editor'], f1, c)).to.throw(AuthzConfigError, 'coversAt');
    });

    it('a cap also drops a role of another ladder that extends above it', async () => {
      const roles = [...ROLES.filter((r) => r.name !== 'org.owner'), role('org.owner', ['org:audit'], { ladder: 'org', extends: ['maintainer'] })];
      const m = await model([assignment('a1', 'org.owner', O1)], [capOf({})], roles);
      expect((await vote(m, 'file:admin', f1)).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'org:audit', f1)).permitWhen).to.deep.equal(FALSE);
      expect((await vote(m, 'org:audit', f1)).roles).to.deep.equal({});
    });

    it('a cap condition that reads the row through a function arg is refused at boot', async () => {
      await rejects(model([assignment('a1', 'editor')], [capOf({ when: { fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'x*' } } })]), 'cannot follow per row');
    });
  });

  it('rules ignore a store-less model', async () => {
    const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore([assignment('a1', 'editor')]), log: { warn: () => undefined } });
    await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
    expect((await vote(m, 'file:edit', f1)).permitWhen).to.deep.equal(TRUE);
    expect(AuthzConfigError).to.be.a('function');
  });
});
