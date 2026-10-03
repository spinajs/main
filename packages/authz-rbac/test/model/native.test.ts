import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, NativeFilter, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { FakeRelationResolver, FakeScopeResolver, evaluateFilter, fakeEvaluationContext, userPrincipal, withCeiling, withCompanions } from '@spinajs/authz-testing';
import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { MAX_ARGS_ROLES, MAX_ARGS_SUBJECTS, MemoryAssignmentStore, MemoryRoleStore, RbacAssignmentFilter, compileGrants, compileRoles, gatherRbacInput, parseRbacAssignmentArgs, rbacAssignmentArgs, rbacAssignmentExtension, runRbacPipeline } from '../../src/index.js';
import type { AssignmentStore, RbacExtension, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');
const bot = { type: 'service', id: 'bot' };
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const FILES = ['f1', 'f2', 'f3', 'f4'].map((id): ResourceRef => ({ type: 'file', id }));
// o1 → p1 → f1, f2; o1 → p2 → f3; o1 → f4
const NODES = [
  { ref: P1, parent: O1 },
  { ref: P2, parent: O1 },
  { ref: FILES[0], parent: P1 },
  { ref: FILES[1], parent: P1 },
  { ref: FILES[2], parent: P2 },
  { ref: FILES[3], parent: O1 },
];
const context = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver({ nodes: NODES })] });

const assignment = (id: string, role: string, scope: ResourceRef, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role, scope, source: 'test', ...extra });
const args = (roles: readonly string[], subjects: readonly AssignmentSubject[] = [{ type: 'user', id: 'alice' }]) => rbacAssignmentArgs(subjects, roles);

describe('authz-rbac model: native:rbac.assignment', () => {
  describe('args', () => {
    it('are canonical: subjects by subjectKey, roles by code point, no duplicates, frozen', () => {
      const set = { set: { role: 'team.member', scope: { type: 'team', id: 't1' } } };
      const a = rbacAssignmentArgs([{ type: 'user', id: 'alice' }, set, bot, { type: 'user', id: 'alice' }], ['viewer', 'editor', 'viewer']);
      expect(a).to.deep.equal({ v: 1, subjects: [set, bot, { type: 'user', id: 'alice' }], roles: ['editor', 'viewer'] });
      expect(JSON.stringify(rbacAssignmentArgs([bot, { type: 'user', id: 'alice' }, set], ['editor', 'viewer']))).to.equal(JSON.stringify(a));
      expect(Object.isFrozen(a) && Object.isFrozen(a.subjects) && Object.isFrozen(a.roles)).to.equal(true);
    });

    it('copy only the subject fields the assignment table stores', () => {
      const a = rbacAssignmentArgs([{ ...alice, companions: [bot] } as unknown as AssignmentSubject], ['viewer']);
      expect(a.subjects).to.deep.equal([{ type: 'user', id: 'alice' }]);
    });

    it('past the size bounds throw', () => {
      expect(() =>
        rbacAssignmentArgs(
          [{ type: 'user', id: 'a' }],
          Array.from({ length: MAX_ARGS_ROLES + 1 }, (_, i) => `r${i}`),
        ),
      ).to.throw(/exceed/);
      expect(() =>
        rbacAssignmentArgs(
          Array.from({ length: MAX_ARGS_SUBJECTS + 1 }, (_, i) => ({ type: 'user', id: `u${i}` })),
          ['viewer'],
        ),
      ).to.throw(/exceed/);
    });

    it('parse back only in the canonical v1 shape', () => {
      const good = args(['editor', 'viewer']);
      expect(parseRbacAssignmentArgs(JSON.parse(JSON.stringify(good)))).to.deep.equal(good);
      const bad: unknown[] = [
        null,
        [],
        { ...good, v: 2 },
        { ...good, restrict: [] },
        { v: 1, subjects: good.subjects },
        { ...good, roles: ['viewer', 'editor'] },
        { ...good, roles: ['viewer', 'viewer'] },
        { ...good, roles: [''] },
        { ...good, subjects: [{ type: 'user' }] },
        { ...good, subjects: [{ type: 'user', id: 'alice', extra: 1 }] },
        {
          ...good,
          subjects: [
            { id: 'alice', type: 'user' },
            { id: 'alice', type: 'user' },
          ],
        },
        { ...good, subjects: [{ set: { role: 'r', scope: { type: 't', id: 1 } } }] },
      ];
      for (const b of bad) expect(() => parseRbacAssignmentArgs(b), JSON.stringify(b)).to.throw(/native:rbac\.assignment/);
    });
  });

  describe('RbacAssignmentFilter', () => {
    const matches = (store: AssignmentStore, a: unknown, ref: ResourceRef, ctx = context()) => new RbacAssignmentFilter(store).matches(a, undefined, ref, ctx);

    it('holds when a subject has a live assignment of a listed role on the row path', async () => {
      const store = new MemoryAssignmentStore([assignment('a1', 'viewer', P1), assignment('a2', 'editor', P2), assignment('a3', 'viewer', FILES[3]), assignment('b1', 'viewer', P2, { subject: bot })]);
      expect(await matches(store, args(['viewer']), FILES[0])).to.equal(true);
      expect(await matches(store, args(['viewer']), FILES[1])).to.equal(true);
      expect(await matches(store, args(['viewer']), FILES[2])).to.equal(false);
      expect(await matches(store, args(['viewer']), FILES[3])).to.equal(true);
      expect(await matches(store, args(['editor']), FILES[2])).to.equal(true);
      expect(await matches(store, args(['viewer'], [{ type: 'user', id: 'alice' }, bot]), FILES[2])).to.equal(true);
      expect(await matches(store, args([]), FILES[0])).to.equal(false);
    });

    it('GLOBAL matches every row; a type-only scope the rows of its own type only, as on the check path', async () => {
      expect(await matches(new MemoryAssignmentStore([assignment('a1', 'viewer', GLOBAL)]), args(['viewer']), FILES[2])).to.equal(true);
      expect(await matches(new MemoryAssignmentStore([assignment('a1', 'viewer', { type: 'file' })]), args(['viewer']), FILES[2])).to.equal(true);
      expect(await matches(new MemoryAssignmentStore([assignment('a1', 'viewer', { type: 'project' })]), args(['viewer']), FILES[2])).to.equal(false);
    });

    it('an assignment expired at ctx.now does not match; an unreadable expiresAt throws', async () => {
      expect(await matches(new MemoryAssignmentStore([assignment('a1', 'viewer', P1, { expiresAt: NOW })]), args(['viewer']), FILES[0])).to.equal(false);
      expect(await matches(new MemoryAssignmentStore([assignment('a1', 'viewer', P1, { expiresAt: new Date(NOW.getTime() + 1) })]), args(['viewer']), FILES[0])).to.equal(true);
      const store: AssignmentStore = { name: 'raw', forSubjects: async () => [assignment('a1', 'viewer', P1, { expiresAt: 'soon' as unknown as Date })], holders: async () => [], byId: async () => null };
      let error: unknown;
      await matches(store, args(['viewer']), FILES[0]).catch((e: unknown) => (error = e));
      expect(String(error)).to.match(/unreadable expiresAt/);
    });

    it('reads the store once per subject list within one request', async () => {
      const inner = new MemoryAssignmentStore([assignment('a1', 'viewer', P1)]);
      let reads = 0;
      const store: AssignmentStore = { name: 'counting', forSubjects: (s, at) => (reads++, inner.forSubjects(s, at)), holders: async () => [], byId: async () => null };
      const ctx = context();
      for (const f of FILES) await matches(store, args(['viewer']), f, ctx);
      expect(reads).to.equal(1);
    });

    it('refuses malformed args and an unknown resource', async () => {
      const store = new MemoryAssignmentStore([]);
      let error: unknown;
      await matches(store, { v: 2 }, FILES[0]).catch((e: unknown) => (error = e));
      expect(String(error)).to.match(/unsupported args version/);
      error = undefined;
      await matches(store, args(['viewer']), { type: 'file', id: 'ghost' }).catch((e: unknown) => (error = e));
      expect(String(error)).to.match(/unknown resource/);
    });
  });

  describe('check ⇔ list (B06 property)', () => {
    const ROLES: RoleDef[] = [
      { name: 'viewer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read' }] },
      { name: 'editor', extends: ['viewer'], assignable: true, source: 'test', grants: [{ permission: 'file:write' }] },
      { name: 'limited', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read', on: [{ type: 'file', id: 'f1' }] }] },
      { name: 'writer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:write' }] },
      { name: 'owner', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read', relation: 'owner' }] },
    ];
    const ROLE_NAMES = ROLES.map((r) => r.name);
    const OWNERS: Record<string, string> = { f1: 'alice', f2: 'bob', f3: 'alice', f4: 'carol' };
    const row = (f: ResourceRef) => ({ id: f.id, owner: OWNERS[f.id!] });
    const owner = new FakeRelationResolver('file', 'owner', (p, _ref, subject) => (subject as { owner?: string } | undefined)?.owner === p.id);
    const relational = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver({ nodes: NODES })], relations: [owner] });
    const registry = new PermissionRegistryImpl();
    registry.register(
      [
        { name: 'file:read', types: ['file', 'project', 'org'] },
        { name: 'file:write', types: ['file', 'project', 'org'] },
      ],
      'test',
    );
    registry.freeze();
    const graph = compileRoles(ROLES);
    const grants = compileGrants(graph, registry);
    const SCOPES: ResourceRef[] = [GLOBAL, O1, P1, P2, ...FILES, { type: 'project' }, { type: 'file' }];

    async function vote(principal: Principal, store: AssignmentStore, resource: ResourceRef, extensions: readonly RbacExtension[]) {
      const ctx = relational();
      return runRbacPipeline(await gatherRbacInput({ principal, permission: 'file:read', resource }, ctx, { roles: graph, grants, assignments: store, extensions }));
    }

    const holds = async (residual: ResourceFilter, principal: Principal, f: ResourceRef, filters: readonly NativeFilter[]) => (await evaluateFilter(residual, row(f), { principal, ref: f, context: relational(), nativeFilters: filters })) === true;

    async function listed(residual: ResourceFilter, principal: Principal, filters: readonly NativeFilter[]): Promise<string[]> {
      const out: string[] = [];
      for (const f of FILES) if (await holds(residual, principal, f, filters)) out.push(f.id!);
      return out;
    }

    const assignmentArb = fc.record({ role: fc.constantFrom(...ROLE_NAMES, 'ghost'), scope: fc.constantFrom(...SCOPES), bot: fc.boolean(), expired: fc.boolean() });
    // undefined: no ceiling; [] included.
    const ceilingArb = fc.option(fc.subarray(ROLE_NAMES), { nil: undefined });

    it('for random assignments and ceilings, every row is listed exactly when its check permits, with under and with native', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(assignmentArb, { maxLength: 6 }), ceilingArb, async (drawn, roles) => {
          const rows = drawn.map((d, i) => assignment(`a${i}`, d.role, d.scope, { ...(d.bot ? { subject: bot } : {}), ...(d.expired ? { expiresAt: NOW } : {}) }));
          const store = new MemoryAssignmentStore(rows);
          const principal = roles === undefined ? withCompanions(alice, [bot]) : withCeiling(withCompanions(alice, [bot]), { roles });
          const options = { roles: new MemoryRoleStore(ROLES), assignments: store };
          for (const extensions of [[], [rbacAssignmentExtension(options)]]) {
            const filters = extensions.flatMap((e) => e.nativeFilters?.() ?? []);
            const typeLevel = (await vote(principal, store, { type: 'file' }, extensions)).permitWhen;
            const got = await listed(typeLevel, principal, filters);
            const want: string[] = [];
            for (const f of FILES) if (await holds((await vote(principal, store, f, extensions)).permitWhen, principal, f, filters)) want.push(f.id!);
            expect(got, JSON.stringify({ rows, roles, typeLevel })).to.deep.equal(want);
          }
        }),
        { numRuns: 150 },
      );
    });
  });
});
