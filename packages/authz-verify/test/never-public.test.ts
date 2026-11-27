import 'mocha';
import { expect } from 'chai';

import type { PolicyIR, RelationDef, Rewrite, SubjectTypeRef } from '@spinajs/authz-ir';

import { accessOf, permissionMatrix, releaseSolver, verifyAssertion } from '../src/index.js';
import type { Assertion, SatSolver, Verdict } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';

const source = { origin: 'config:authz' };
const tuples = (allowed: SubjectTypeRef[]): RelationDef => ({ allowed, source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
const bind = (type: string, relation: string) => ({ type, relation, list: false, source });

/** Users enter a tenant through `enter`; `relations` are the tenant's, `role` maps `role:<name>` to `tenant#<name>`. */
function policy(relations: Record<string, SubjectTypeRef[]>, enter: Rewrite = { computed: 'member' }, more: { roles?: string[]; group?: SubjectTypeRef[] } = {}): PolicyIR {
  const rels = Object.fromEntries(Object.entries(relations).map(([name, allowed]) => [name, tuples(allowed)]));
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      ...(more.group === undefined ? {} : { group: { relations: { member: tuples(more.group) }, permissions: {} } }),
      tenant: { relations: rels, permissions: { enter, view: { computed: 'member' }, closed: { intersection: [] } } },
    },
    permissions: { 'tenant:enter': bind('tenant', 'enter'), 'tenant:view': bind('tenant', 'view') },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: Object.fromEntries((more.roles ?? []).map((r) => [r, [{ type: 'tenant', relation: r }]])) },
    opaque: [],
  };
}

const publicOnly = (): PolicyIR => policy({ member: ['user:*'], admin: ['user'] }, undefined, { roles: ['member'] });
/** The same reach under an intersection with a term that holds for everyone: not monotone, so the bounded engine answers. */
const bounded = (ir: PolicyIR): PolicyIR => {
  const tenant = ir.types.tenant;
  return { ...ir, types: { ...ir.types, tenant: { ...tenant, permissions: { ...tenant.permissions, enter: { intersection: [tenant.permissions.enter, { intersection: [] }] } } } } };
};

const tupleNames = (v: Verdict): string[] => (v.counterexample?.tuples ?? []).map((t) => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}${t.subject.relation === undefined ? '' : `#${t.subject.relation}`}`);
const publicMember = (v: Verdict): boolean => tupleNames(v).some((n) => /^tenant:t\d#member@user:\*$/.test(n));
const never = (holder: string, permission = 'tenant:enter'): Assertion => ({ kind: 'never', holder, permission });

describe('never(holder) with public members', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;
  const verdictOf = (ir: PolicyIR, a: Assertion, k: number): Promise<Verdict> => verifyAssertion(ir, a, { k, solver: () => Promise.resolve(z3) });

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: the never() public member tests are skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  for (const k of [2, 3]) {
    describe(`k = ${k}`, () => {
      it('counts a public-only member of the relation or the role as that holder', async () => {
        for (const holder of ['tenant#member', 'role:member', 'role:member@tenant', 'public:tenant#member']) {
          const v = await verdictOf(publicOnly(), never(holder), k);
          expect([v.result, v.engine], holder).to.deep.equal(['violated', 'exact']);
          expect(publicMember(v), holder).to.eq(true);
        }
      });

      it('counts it beside a named member', async () => {
        for (const holder of ['tenant#member', 'role:member']) expect((await verdictOf(policy({ member: ['user', 'user:*'] }, undefined, { roles: ['member'] }), never(holder), k)).result, holder).to.eq('violated');
      });

      it('does not count a public tuple on another relation', async () => {
        const ir = policy({ member: ['user'], visitor: ['user:*'] }, undefined, { roles: ['visitor'] });
        for (const holder of ['tenant#visitor', 'role:visitor']) expect(await verdictOf(ir, never(holder), k), holder).to.include({ result: 'holds', engine: 'exact' });
        expect(await verdictOf(publicOnly(), never('tenant#admin'), k)).to.include({ result: 'holds', engine: 'exact' });
        const teams = policy({ member: ['user'], team: ['group'] }, { tupleToUserset: { tupleset: 'team', computed: 'member' } }, { group: ['user:*'] });
        teams.principal.roles = { member: [{ type: 'tenant', relation: 'member' }, { type: 'group', relation: 'member' }] };
        expect(await verdictOf(teams, never('role:member@tenant'), k)).to.include({ result: 'holds', engine: 'exact' });
        expect(await verdictOf(teams, never('role:member@group'), k)).to.include({ result: 'violated', engine: 'exact' });
      });

      it('counts a public member a deny may miss, and holds where the deny takes the permission from everyone', async () => {
        const banned = policy({ member: ['user:*'], banned: ['user', 'user:*'] }, { exclusion: { base: { computed: 'member' }, subtract: { computed: 'banned' } } });
        const v = await verdictOf(banned, never('tenant#member'), k);
        expect(v).to.include({ result: 'violated', engine: 'bounded', bound: k });
        expect(publicMember(v)).to.eq(true);
        expect(tupleNames(v).some((n) => n.includes('#banned@'))).to.eq(false);
        const closed = policy({ member: ['user:*'] }, { exclusion: { base: { computed: 'member' }, subtract: { computed: 'closed' } } });
        expect(await verdictOf(closed, never('tenant#member'), k)).to.include({ result: 'holds', engine: 'bounded', bound: k });
        const noSolver = { k, solver: () => Promise.resolve(undefined) };
        for (const ir of [banned, closed]) expect(await verifyAssertion(ir, never('tenant#member'), noSolver)).to.include({ result: 'unknown', code: 'AZV090' });
      });

      it('counts a public member reached through a subject set as a holder of the outer relation', async () => {
        const v = await verdictOf(policy({ member: ['group#member'] }, undefined, { group: ['user:*'] }), never('tenant#member'), k);
        expect([v.result, v.engine]).to.deep.equal(['violated', 'exact']);
        expect(tupleNames(v)).to.include.members(['tenant:t1#member@group:g1#member', 'group:g1#member@user:*']);
      });

      it('gets the same verdict from the exact and the bounded engine', async () => {
        const cases: Array<[PolicyIR, string]> = [
          [publicOnly(), 'tenant#member'],
          [publicOnly(), 'role:member'],
          [publicOnly(), 'tenant#admin'],
          [policy({ member: ['user', 'user:*'] }, undefined, { roles: ['member'] }), 'role:member'],
          [policy({ member: ['user'], visitor: ['user:*'] }), 'tenant#visitor'],
        ];
        for (const [ir, holder] of cases) {
          const exact = await verdictOf(ir, never(holder), k);
          const search = await verdictOf(bounded(ir), never(holder), k);
          expect([exact.engine, search.engine], holder).to.deep.equal(['exact', 'bounded']);
          expect(search.result, holder).to.eq(exact.result);
        }
      });
    });
  }

  it('the matrix and never() agree on a public-only membership', async () => {
    for (const ir of [publicOnly(), policy({ member: ['user:*'], admin: ['user'] })]) {
      const m = permissionMatrix(ir);
      const roles = Object.keys(ir.principal.roles).length > 0 ? ['role:member', 'role:member@tenant'] : [];
      const keys = [...Object.keys(m.cells), 'tenant#member', ...roles, 'tenant#admin', 'public'];
      for (const holder of keys) {
        for (const permission of m.permissions) {
          const v = await verdictOf(ir, never(holder, permission), 2);
          const access = accessOf(m, holder, permission);
          expect([holder, permission, v.result === 'holds'], 'never holds exactly where the matrix says never').to.deep.equal([holder, permission, access === 'never']);
          expect([holder, permission, v.result === 'violated'], 'never is violated exactly where the matrix says always').to.deep.equal([holder, permission, access === 'always']);
        }
      }
    }
    expect(accessOf(permissionMatrix(publicOnly()), 'role:member@tenant', 'tenant:enter')).to.eq('always');
    expect(accessOf(permissionMatrix(policy({ member: ['user:*'] })), 'tenant#member', 'tenant:view')).to.eq('always');
  });

  it('leaves onlyVia, implies and separated on a public-only membership as they were', async () => {
    const ir = publicOnly();
    for (const holders of [['tenant#member'], ['role:member']]) expect((await verdictOf(ir, { kind: 'onlyVia', permission: 'tenant:enter', holders }, 2)).result, holders.join()).to.eq('violated');
    expect(await verdictOf(ir, { kind: 'onlyVia', permission: 'tenant:enter', holders: ['public:tenant#member'] }, 2)).to.include({ result: 'holds', engine: 'exact' });
    expect(await verdictOf(ir, { kind: 'implies', a: 'tenant:enter', b: 'tenant:view' }, 2)).to.include({ result: 'holds', engine: 'exact' });
    expect(await verdictOf(ir, { kind: 'separated', a: 'tenant:enter', b: 'tenant:view', on: 'same-resource' }, 2)).to.include({ result: 'violated', engine: 'exact' });
  });
});
