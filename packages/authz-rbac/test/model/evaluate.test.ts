import { DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, RBAC_STEPS, RBAC_STEP_NAMES, compileGrants, compileRoles, gatherRbacInput, runRbacPipeline } from '../../src/index.js';
import type { RbacInput, RbacState, RbacSteps, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly string[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
const assignment = (id: string, roleName: string, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope: GLOBAL, source: 'test', ...extra });

const ROLES = [role('viewer', ['file:read']), role('writer', ['file:write']), role('editor', [], { extends: ['viewer', 'writer'] })];

function input(assignments: readonly Assignment[], permission: string, opts: { roles?: readonly RoleDef[]; permissions?: readonly (string | PermissionInput)[]; onUnknownRole?: (a: Assignment) => void } = {}): RbacInput {
  const registry = new PermissionRegistryImpl();
  registry.register(
    (opts.permissions ?? ['file:read', 'file:write', 'file:delete']).map((p) => (typeof p === 'string' ? { name: p } : p)),
    'test',
  );
  registry.freeze();
  const roles = compileRoles(opts.roles ?? ROLES);
  return { request: { principal: alice, permission, resource: f1 }, now: NOW, path: [GLOBAL], assignments, roles, grants: compileGrants(roles, registry), onUnknownRole: opts.onUnknownRole };
}

const NO_ACCESS = { code: 'no_access', priority: DEFAULT_DENY_PRIORITY.no_access };

/** The default table with some steps replaced. */
const withSteps = (replace: Partial<RbacSteps>): RbacSteps => ({ ...RBAC_STEPS, ...replace });

describe('authz-rbac model: the evaluation pipeline', () => {
  describe('default steps', () => {
    it('a global assignment whose role grants the permission permits it unconditionally', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'viewer')], 'file:read'));
      expect(vote.model).to.equal('rbac');
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.denyWhen).to.deep.equal(FALSE);
      expect(vote.reason).to.equal(undefined);
      expect(vote.denies).to.equal(undefined);
      expect(vote.roles).to.deep.equal({});
      expect(vote.cacheable).to.equal(true);
      expect(vote.validUntil).to.equal(undefined);
    });

    it('the permissions are the union over every global assignment (H1)', () => {
      const both = [assignment('a1', 'viewer'), assignment('a2', 'writer')];
      expect(runRbacPipeline(input(both, 'file:read')).permitWhen).to.deep.equal(TRUE);
      expect(runRbacPipeline(input(both, 'file:write')).permitWhen).to.deep.equal(TRUE);
      expect(runRbacPipeline(input(both, 'file:delete')).permitWhen).to.deep.equal(FALSE);
    });

    it('a role passes on the grants of the roles it extends', () => {
      expect(runRbacPipeline(input([assignment('a1', 'editor')], 'file:write')).permitWhen).to.deep.equal(TRUE);
    });

    it('no assignment: a permit of FALSE with reason no_access, never a deny', () => {
      const vote = runRbacPipeline(input([], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(FALSE);
      expect(vote.denyWhen).to.deep.equal(FALSE);
      expect(vote.denies).to.equal(undefined);
      expect(vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('a role without the permission gives no_access', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer')], 'file:write')).reason).to.deep.equal(NO_ACCESS);
    });

    it('collect keeps only the assignments whose scope is on the path', () => {
      const scoped = [assignment('a1', 'viewer', { scope: { type: 'project', id: 'p1' } })];
      expect(runRbacPipeline(input(scoped, 'file:read')).reason).to.deep.equal(NO_ACCESS);
      const onPath = { ...input(scoped, 'file:read'), path: [f1, { type: 'project', id: 'p1' }, GLOBAL] };
      expect(runRbacPipeline(onPath).permitWhen).to.deep.equal(TRUE);
    });

    it('an expired assignment is not collected, even if a store returns it', () => {
      expect(runRbacPipeline(input([assignment('a1', 'viewer', { expiresAt: new Date(NOW.getTime() - 1) })], 'file:read')).reason).to.deep.equal(NO_ACCESS);
      expect(runRbacPipeline(input([assignment('a1', 'viewer', { expiresAt: new Date(NOW.getTime() + 1) })], 'file:read')).permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment of a role the graph does not hold is ignored and reported', () => {
      const unknown: Assignment[] = [];
      const vote = runRbacPipeline(input([assignment('g1', 'ghost'), assignment('a1', 'viewer')], 'file:read', { onUnknownRole: (a) => unknown.push(a) }));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(unknown.map((a) => a.id)).to.deep.equal(['g1']);
    });

    it('one candidate per grant, with every live assignment that reaches it', () => {
      let seen: RbacState | undefined;
      runRbacPipeline(
        input([assignment('a1', 'viewer'), assignment('a2', 'editor')], 'file:read'),
        withSteps({
          tag: (s) => {
            seen = s;
          },
        }),
      );
      expect(seen!.candidates).to.have.length(1);
      expect(seen!.candidates[0].grant.role).to.equal('viewer');
      expect(seen!.candidates[0].holders.map((h) => h.assignment.id)).to.deep.equal(['a1', 'a2']);
      expect(seen!.live.map((l) => l.role)).to.deep.equal(['viewer', 'editor']);
    });
  });

  describe('hooks', () => {
    it('runs the nine steps of design §6.1.2 in order', () => {
      const ran: string[] = [];
      const recording = { ...Object.fromEntries(RBAC_STEP_NAMES.map((name) => [name, () => void ran.push(name)])), noGrantReason: () => ({ code: 'none' }) } as unknown as RbacSteps;
      runRbacPipeline(input([assignment('a1', 'viewer')], 'file:read'), recording);
      expect(ran).to.deep.equal(['collect', 'restrict', 'cap', 'aggregate', 'grant', 'tag', 'provenance', 'threshold', 'residual']);
      expect(Object.keys(RBAC_STEPS)).to.deep.equal([...ran, 'noGrantReason']);
      expect(Object.isFrozen(RBAC_STEPS)).to.equal(true);
    });

    it('a step that refuses a candidate takes its permit away and gives its reason', () => {
      const vote = runRbacPipeline(
        input([assignment('a1', 'viewer')], 'file:read'),
        withSteps({
          tag: (s) => {
            for (const c of s.candidates) {
              c.failed = true;
              s.reasons.push({ code: 'tag_missing', tag: 'code', priority: DEFAULT_DENY_PRIORITY.tag_missing });
            }
          },
        }),
      );
      expect(vote.permitWhen).to.deep.equal(FALSE);
      expect(vote.denyWhen).to.deep.equal(FALSE);
      expect(vote.reason).to.deep.equal({ code: 'tag_missing', tag: 'code', priority: 420 });
    });

    it('a deny entry becomes denyWhen and denies; Vote.reason stays the non-permit reason', () => {
      const branch = { code: 'branch_protected', priority: 300, sortKey: 'a*' };
      const vote = runRbacPipeline(
        input([], 'file:read'),
        withSteps({
          threshold: (s) => {
            s.denies.push({ when: TRUE, reason: branch });
            s.denies.push({ when: FALSE, reason: { code: 'never', priority: 1 } });
          },
        }),
      );
      expect(vote.denyWhen).to.deep.equal(TRUE);
      expect(vote.denies).to.deep.equal([{ when: TRUE, reason: branch }]);
      expect(vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('noGrantReason replaces no_access when no grant is reachable', () => {
      const tooLow = { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor', priority: 410 };
      expect(runRbacPipeline(input([], 'file:read'), withSteps({ noGrantReason: () => tooLow })).reason).to.deep.equal(tooLow);
      expect(runRbacPipeline(input([assignment('a1', 'viewer')], 'file:read'), withSteps({ noGrantReason: () => tooLow })).reason).to.equal(undefined);
    });

    it('no reason while some grant permits, even if another one failed', () => {
      const vote = runRbacPipeline(
        input([assignment('a1', 'viewer')], 'file:read', { roles: [role('viewer', ['file:read', 'file:*'])] }),
        withSteps({
          tag: (s) => {
            s.candidates[0].failed = true;
            s.reasons.push({ code: 'tag_missing', tag: 'x' });
          },
        }),
      );
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.reason).to.equal(undefined);
    });

    it('aggregate fills Vote.roles, and the state carries fields and validUntil to the vote', () => {
      const until = new Date(NOW.getTime() + 60_000);
      const vote = runRbacPipeline(
        input([assignment('a1', 'viewer')], 'file:read'),
        withSteps({
          aggregate: (s) => {
            s.roles.project = 'viewer';
            s.validUntil = until;
            s.fields = { read: ['name'] };
          },
        }),
      );
      expect(vote.roles).to.deep.equal({ project: 'viewer' });
      expect(vote.validUntil).to.deep.equal(until);
      expect(vote.fields).to.deep.equal({ read: ['name'] });
    });
  });

  describe('relation residuals (B15)', () => {
    const rel = (relation: string) => ({ op: 'relation' as const, relation });
    const withGrants = (name: string, grants: RoleDef['grants']): RoleDef => ({ ...role(name), grants });
    const RELATION_ROLES = [
      withGrants('owner-reader', [{ permission: 'file:read', relation: 'owner' }]),
      withGrants('either', [{ permission: 'file:read', relation: ['owner', 'member'] }]),
      withGrants('two-grants', [
        { permission: 'file:read', relation: 'owner' },
        { permission: 'file:read', relation: 'member' },
      ]),
      withGrants('member-reader', [{ permission: 'file:read', relation: 'member' }]),
      role('reader', ['file:read']),
    ];
    const vote = (roleNames: readonly string[]) =>
      runRbacPipeline(
        input(
          roleNames.map((r, i) => assignment(`a${i}`, r)),
          'file:read',
          { roles: RELATION_ROLES },
        ),
      );

    it('a grant with relation R permits when relation(R) holds, and gives no reason', () => {
      const v = vote(['owner-reader']);
      expect(v.permitWhen).to.deep.equal(rel('owner'));
      expect(v.denyWhen).to.deep.equal(FALSE);
      expect(v.reason).to.equal(undefined);
    });

    it('several relations in one grant are OR-ed', () => {
      expect(vote(['either']).permitWhen).to.deep.equal({ op: 'or', args: [rel('owner'), rel('member')] });
    });

    it('grants of one permission with different relations are OR-ed, within a role and across roles', () => {
      expect(vote(['two-grants']).permitWhen).to.deep.equal({ op: 'or', args: [rel('owner'), rel('member')] });
      expect(vote(['owner-reader', 'member-reader']).permitWhen).to.deep.equal({ op: 'or', args: [rel('owner'), rel('member')] });
    });

    it('a grant without relation is unconditional and absorbs the relation grants', () => {
      expect(vote(['owner-reader', 'reader']).permitWhen).to.deep.equal(TRUE);
      expect(vote(['reader', 'either']).permitWhen).to.deep.equal(TRUE);
    });

    it('one relation reached through two roles appears once', () => {
      expect(vote(['owner-reader', 'two-grants']).permitWhen).to.deep.equal({ op: 'or', args: [rel('owner'), rel('member')] });
    });

    it('a refused relation grant adds nothing to permitWhen', () => {
      const v = runRbacPipeline(
        input([assignment('a1', 'owner-reader'), assignment('a2', 'member-reader')], 'file:read', { roles: RELATION_ROLES }),
        withSteps({
          tag: (s) => {
            s.candidates.find((c) => c.grant.role === 'member-reader')!.failed = true;
          },
        }),
      );
      expect(v.permitWhen).to.deep.equal(rel('owner'));
    });

    it('a type-level request gets the same residual: every row is checked against relation(R)', () => {
      const base = input([assignment('a1', 'owner-reader')], 'file:read', { roles: RELATION_ROLES });
      expect(runRbacPipeline({ ...base, request: { ...base.request, resource: { type: 'file' } } }).permitWhen).to.deep.equal(rel('owner'));
    });
  });

  describe('scoped assignments along the resource path (B13)', () => {
    // o1 → p1 → f1, o1 → p2 → f2
    const O1: ResourceRef = { type: 'org', id: 'o1' };
    const P1: ResourceRef = { type: 'project', id: 'p1' };
    const P2: ResourceRef = { type: 'project', id: 'p2' };
    const f2: ResourceRef = { type: 'file', id: 'f2' };
    const scopes = () =>
      new FakeScopeResolver({
        nodes: [
          { ref: P1, parent: O1 },
          { ref: f1, parent: P1 },
          { ref: P2, parent: O1 },
          { ref: f2, parent: P2 },
        ],
      });

    async function evaluate(assignments: readonly Assignment[], resource: ResourceRef, ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes()] })) {
      const registry = new PermissionRegistryImpl();
      registry.register(
        ['file:read', 'file:write'].map((name) => ({ name, types: ['org', 'project', 'file'] })),
        'test',
      );
      registry.freeze();
      const roles = compileRoles(ROLES);
      const gathered = await gatherRbacInput({ principal: alice, permission: 'file:read', resource }, ctx, { roles, grants: compileGrants(roles, registry), assignments: new MemoryAssignmentStore(assignments) });
      return { input: gathered, vote: runRbacPipeline(gathered), ctx };
    }

    // A fresh ref, equal by value only: scopes match by resourceKey, not by identity.
    const at = (ref: ResourceRef, id = 'a1') => assignment(id, 'viewer', { scope: { ...ref } });

    it('an assignment at the resource itself applies to it', async () => {
      expect((await evaluate([at(f1)], f1)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment at S applies to S', async () => {
      expect((await evaluate([at(P1)], P1)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment at S applies to the descendants of S', async () => {
      expect((await evaluate([at(P1)], f1)).vote.permitWhen).to.deep.equal(TRUE);
      expect((await evaluate([at(O1)], f1)).vote.permitWhen).to.deep.equal(TRUE);
      expect((await evaluate([at(O1)], f2)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('an assignment at S does not apply to an ancestor of S', async () => {
      expect((await evaluate([at(P1)], O1)).vote.reason).to.deep.equal(NO_ACCESS);
      expect((await evaluate([at(f1)], P1)).vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('an assignment at S does not apply to a sibling of S or its descendants', async () => {
      expect((await evaluate([at(P1)], P2)).vote.reason).to.deep.equal(NO_ACCESS);
      expect((await evaluate([at(P1)], f2)).vote.reason).to.deep.equal(NO_ACCESS);
    });

    it('a GLOBAL assignment applies to every concrete resource', async () => {
      for (const r of [f1, f2, P1, O1]) expect((await evaluate([assignment('g1', 'viewer')], r)).vote.permitWhen).to.deep.equal(TRUE);
    });

    it('the path is the ancestors list, read once per evaluation', async () => {
      const { input: gathered, ctx } = await evaluate([at(P1)], f1);
      expect(gathered.path).to.deep.equal([f1, P1, O1, GLOBAL]);
      expect(ctx.stats.ancestors.calls).to.equal(1);
    });

    it('the resource itself and GLOBAL are on the path even when the ancestors list leaves them out', async () => {
      const base = fakeEvaluationContext({ now: NOW });
      const ctx = Object.assign(Object.create(base) as typeof base, { ancestors: async () => [P1] });
      const { input: gathered, vote } = await evaluate([assignment('g1', 'viewer')], f1, ctx);
      expect(gathered.path).to.deep.equal([f1, P1, GLOBAL]);
      expect(vote.permitWhen).to.deep.equal(TRUE);
    });

    it('the path is nearest first and GLOBAL stays last even when the ancestors list holds it earlier', async () => {
      const base = fakeEvaluationContext({ now: NOW });
      const ctx = Object.assign(Object.create(base) as typeof base, { ancestors: async () => [f1, GLOBAL, P1, O1] });
      const { input: gathered } = await evaluate([], f1, ctx);
      expect(gathered.path).to.deep.equal([f1, P1, O1, GLOBAL]);
    });

    it('a type-level request counts GLOBAL assignments only and reads no ancestors', async () => {
      const typeLevel: ResourceRef = { type: 'file' };
      const scoped = await evaluate([at(P1), at(f1, 'a2'), assignment('a3', 'viewer', { scope: { type: 'file' } })], typeLevel);
      expect(scoped.vote.permitWhen).to.deep.equal(FALSE);
      expect(scoped.vote.reason).to.deep.equal(NO_ACCESS);
      expect(scoped.input.path).to.deep.equal([GLOBAL]);
      expect(scoped.ctx.stats.ancestors.calls).to.equal(0);
      expect((await evaluate([assignment('g1', 'viewer')], typeLevel)).vote.permitWhen).to.deep.equal(TRUE);
    });
  });

  describe('expiry and validUntil (B14)', () => {
    const after = (ms: number) => new Date(NOW.getTime() + ms);
    const HOUR = 3_600_000;
    const expiring = (id: string, roleName: string, expiresAt: unknown) => assignment(id, roleName, { expiresAt: expiresAt as Date });

    it('an assignment expiring exactly at now is expired; one a millisecond later is live until then', () => {
      expect(runRbacPipeline(input([expiring('a1', 'viewer', after(0))], 'file:read')).reason).to.deep.equal(NO_ACCESS);
      const vote = runRbacPipeline(input([expiring('a1', 'viewer', after(1))], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.deep.equal(after(1));
    });

    it('validUntil is the earliest expiry among the assignments that reach the permission', () => {
      const vote = runRbacPipeline(input([expiring('a1', 'viewer', after(2 * HOUR)), expiring('a2', 'editor', after(HOUR)), expiring('a3', 'viewer', after(3 * HOUR))], 'file:read'));
      expect(vote.validUntil).to.deep.equal(after(HOUR));
    });

    it('an expiring assignment whose roles do not reach the permission leaves validUntil alone', () => {
      const vote = runRbacPipeline(input([assignment('a1', 'viewer'), expiring('a2', 'writer', after(60_000))], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.equal(undefined);
      expect(runRbacPipeline(input([expiring('a2', 'writer', after(60_000))], 'file:read')).validUntil).to.equal(undefined);
    });

    it('a null or absent expiresAt never expires and sets no validUntil', () => {
      const vote = runRbacPipeline(input([expiring('a1', 'viewer', null), assignment('a2', 'viewer')], 'file:read'));
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.equal(undefined);
      expect(vote.cacheable).to.equal(true);
    });

    it('a holder of a grant that a step refused still bounds validUntil: its expiry changes the reason', () => {
      const vote = runRbacPipeline(
        input([expiring('a1', 'viewer', after(HOUR))], 'file:read'),
        withSteps({
          tag: (s) => {
            s.candidates[0].failed = true;
            s.reasons.push({ code: 'tag_missing', tag: 'x', priority: DEFAULT_DENY_PRIORITY.tag_missing });
          },
        }),
      );
      expect(vote.permitWhen).to.deep.equal(FALSE);
      expect(vote.validUntil).to.deep.equal(after(HOUR));
    });

    it('an earlier step may set validUntil; the vote keeps the earlier of it and the holders', () => {
      const steps = (until: Date) => withSteps({ aggregate: (s) => void (s.validUntil = until) });
      expect(runRbacPipeline(input([expiring('a1', 'viewer', after(HOUR))], 'file:read'), steps(after(60_000))).validUntil).to.deep.equal(after(60_000));
      expect(runRbacPipeline(input([expiring('a1', 'viewer', after(HOUR))], 'file:read'), steps(after(2 * HOUR))).validUntil).to.deep.equal(after(HOUR));
    });

    it('an unreadable expiresAt (invalid Date, string, number) on the path throws, naming the assignment', () => {
      for (const bad of [new Date(NaN), after(HOUR).toISOString(), after(HOUR).getTime()]) {
        const corrupt = { ...expiring('a1', 'viewer', bad), source: 'db' };
        expect(() => runRbacPipeline(input([corrupt, assignment('a2', 'viewer')], 'file:read')), String(bad)).to.throw(Error, "assignment 'a1' (source: db, role 'viewer') has an unreadable expiresAt");
      }
    });

    it('an unreadable expiresAt off the path is not read', () => {
      const offPath = expiring('a1', 'viewer', 'soon');
      expect(runRbacPipeline(input([{ ...offPath, scope: { type: 'project', id: 'p1' } }, assignment('a2', 'viewer')], 'file:read')).permitWhen).to.deep.equal(TRUE);
    });

    it('validUntil ignores expiring assignments off the path and of unknown roles', () => {
      const vote = runRbacPipeline(
        input(
          [assignment('a1', 'viewer'), expiring('a2', 'viewer', after(60_000)), expiring('a3', 'ghost', after(60_000))].map((a) => (a.id === 'a2' ? { ...a, scope: { type: 'project', id: 'p1' } } : a)),
          'file:read',
          { onUnknownRole: () => undefined },
        ),
      );
      expect(vote.permitWhen).to.deep.equal(TRUE);
      expect(vote.validUntil).to.equal(undefined);
    });

    it('a corrupt row in the memory store reaches the model, which throws; holders leaves it out', async () => {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'file:read' }], 'test');
      registry.freeze();
      const roles = compileRoles([role('viewer', ['file:read'])]);
      const store = new MemoryAssignmentStore([expiring('a1', 'viewer', 'tomorrow'), assignment('a2', 'viewer')]);
      const gathered = await gatherRbacInput({ principal: alice, permission: 'file:read', resource: f1 }, fakeEvaluationContext({ now: NOW }), { roles, grants: compileGrants(roles, registry), assignments: store });
      expect(gathered.assignments.map((a) => a.id)).to.deep.equal(['a1', 'a2']);
      expect(() => runRbacPipeline(gathered)).to.throw(Error, "assignment 'a1'");
      expect(await store.holders('viewer', GLOBAL, NOW)).to.deep.equal([{ type: 'user', id: 'alice' }]);
    });

    it('the gathering re-checks expiry against ctx.now, whatever the store returned', async () => {
      class Unfiltered extends MemoryAssignmentStore {
        override async forSubjects(): Promise<readonly Assignment[]> {
          return this.all();
        }
      }
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'file:read' }], 'test');
      registry.freeze();
      const roles = compileRoles([role('viewer', ['file:read'])]);
      const sources = { roles, grants: compileGrants(roles, registry), assignments: new Unfiltered([expiring('a1', 'viewer', after(HOUR))]) };
      const at = (now: Date) => gatherRbacInput({ principal: alice, permission: 'file:read', resource: f1 }, fakeEvaluationContext({ now }), sources).then(runRbacPipeline);
      // NOW lies before the real clock, so a model reading Date.now() would see a1 as expired here.
      expect((await at(NOW)).validUntil).to.deep.equal(after(HOUR));
      expect((await at(after(HOUR))).reason).to.deep.equal(NO_ACCESS);
    });
  });
});
