import 'mocha';
import { expect } from 'chai';

import type { PolicyIR, RelationDef, SubjectTypeRef, TypeDef } from '@spinajs/authz-ir';

import { defineAssertions, releaseSolver, verifyAssertions } from '../src/index.js';
import type { Assertion, AssertionKit, SatSolver, Verdict } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';

const source = { origin: 'config:authz' };
const tuples = (allowed: SubjectTypeRef[]): RelationDef => ({ allowed, source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
const parentOf = (via: string): RelationDef => ({ allowed: [via], source: { kind: 'ancestor', via } });
const bind = (type: string, relation: string) => ({ type, relation, list: false, source });

/** Users enter a tenant as its members; `more` adds types (or replaces `tenant`) and permissions. */
function policy(members: SubjectTypeRef[], more: { types?: Record<string, TypeDef>; permissions?: PolicyIR['permissions']; caveats?: PolicyIR['caveats']; roles?: PolicyIR['principal']['roles'] } = {}): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      $global: { relations: {}, permissions: {} },
      tenant: { relations: { parent: parentOf('$global'), member: tuples(members) }, permissions: {} },
      ...more.types,
    },
    permissions: { 'tenant:enter': bind('tenant', 'member'), ...more.permissions },
    caveats: more.caveats ?? {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: more.roles ?? {} },
    opaque: [],
  };
}

const memberRole = { roles: { member: [{ type: 'tenant', relation: 'member' }] } };
const entered = (tenant: TypeDef, caveats: PolicyIR['caveats'] = {}): PolicyIR => policy([], { ...memberRole, types: { tenant }, permissions: { 'tenant:enter': bind('tenant', 'enter') }, caveats });
/** The members of a tenant also enter the tenants that name it a partner: a named crossing. */
const partners = (members: SubjectTypeRef[]): PolicyIR =>
  entered({ relations: { parent: parentOf('$global'), member: tuples(members), partner: tuples(['tenant']) }, permissions: { enter: { union: [{ computed: 'member' }, { tupleToUserset: { tupleset: 'partner', computed: 'member' } }] } } });
/** Members enter unless banned: not monotone, so `onlyVia` and `never` go to the bounded engine. */
const banned = (members: SubjectTypeRef[], caveats: PolicyIR['caveats'] = {}): PolicyIR =>
  entered({ relations: { parent: parentOf('$global'), member: tuples(members), banned: tuples(['user']) }, permissions: { enter: { exclusion: { base: { computed: 'member' }, subtract: { computed: 'banned' } } } } }, caveats);

/** Documents under tenants that everyone may view. */
const publicDocs = { types: { doc: { relations: { parent: parentOf('tenant'), viewer: tuples(['user:*']) }, permissions: {} } }, permissions: { 'doc:read': bind('doc', 'viewer') } };
const tupleNames = (v: Verdict): string[] => (v.counterexample?.tuples ?? []).map((t) => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}`);
const publicMember = (v: Verdict): boolean => tupleNames(v).some((n) => /^tenant:t\d#member@user:\*$/.test(n));

describe('isolated(T) with public grants', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;
  const verdictOf = async (ir: PolicyIR, assertion: (kit: AssertionKit) => Assertion, k = 2): Promise<Verdict> => {
    const [result] = await verifyAssertions(ir, defineAssertions((kit) => [assertion(kit)]), { k, solver: () => Promise.resolve(z3) });
    return result.verdict;
  };
  const check = (ir: PolicyIR, except?: string[], k = 2): Promise<Verdict> => verdictOf(ir, ({ isolated }) => isolated('tenant', except === undefined ? {} : { except }), k);

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: the isolated(T) tests are skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  it('finds a tenant everyone may enter', async () => {
    const v = await check(policy(['user', 'user:*']));
    expect(v.result).to.eq('violated');
    expect(tupleNames(v)).to.include('tenant:t1#member@user:*');
  });

  it('finds a document of a tenant everyone may read', async () => {
    const v = await check(policy(['user'], publicDocs));
    expect(v.result).to.eq('violated');
    expect(tupleNames(v)).to.include('doc:d1#viewer@user:*');
  });

  it('holds when the public grants are listed as exceptions', async () => {
    expect(await check(policy(['user', 'user:*'], publicDocs), ['public'])).to.include({ result: 'holds', engine: 'bounded', bound: 2 });
  });

  it('an exception for another holder keeps a public grant a crossing', async () => {
    const v = await check(policy(['user', 'user:*'], publicDocs), ['tenant#member']);
    expect(v.result).to.eq('violated');
    expect(tupleNames(v)).to.include('doc:d1#viewer@user:*');
  });

  it('finds a public grant outside every tenant that reaches into one', async () => {
    const tenant = { relations: { parent: parentOf('$global'), member: tuples(['user']) }, permissions: { enter: { union: [{ computed: 'member' }, { tupleToUserset: { tupleset: 'parent', computed: 'visitor' } }] } } };
    const v = await check(policy(['user'], { types: { tenant, $global: { relations: { visitor: tuples(['user:*']) }, permissions: {} } }, permissions: { 'tenant:enter': bind('tenant', 'enter') } }));
    expect(v.result).to.eq('violated');
    expect(tupleNames(v)).to.include('$global:$global#visitor@user:*');
  });

  it('holds when the public resource lies under no tenant', async () => {
    const pages = { types: { page: { relations: { parent: parentOf('$global'), viewer: tuples(['user:*']) }, permissions: {} } }, permissions: { 'page:read': bind('page', 'viewer') } };
    expect(await check(policy(['user'], pages))).to.include({ result: 'holds', engine: 'bounded', bound: 2 });
  });

  it('does not hold on a public grant under a condition it cannot read', async () => {
    const v = await check(policy(['user', { type: 'user:*', caveat: 'c' }], { caveats: { c: { params: {}, expr: { fn: 'ip.in', args: {} } } } }));
    expect(v.result).to.eq('unknown');
    expect(v.opaque).to.deep.include({ kind: 'condition-function', name: 'ip.in' });
  });

  for (const k of [2, 3]) {
    describe(`a selector that names a relation or a role, k = ${k}`, () => {
      it('as an exception of isolated does not excuse the public grant on that relation', async () => {
        for (const except of ['tenant#member', 'role:member']) {
          const v = await check(policy(['user', 'user:*'], memberRole), [except], k);
          expect(v.result, except).to.eq('violated');
          expect(publicMember(v), except).to.eq(true);
        }
      });

      it('as an exception of isolated still excuses the named holders', async () => {
        expect((await check(partners(['user']), [], k)).result).to.eq('violated');
        for (const except of ['tenant#member', 'role:member']) expect(await check(partners(['user']), [except], k), except).to.include({ result: 'holds', bound: k });
      });

      it('excuses the public grant only next to a public selector', async () => {
        for (const except of [['tenant#member', 'public'], ['role:member', 'public:tenant#member']]) {
          expect(await check(partners(['user', 'user:*']), except, k), except.join()).to.include({ result: 'holds', bound: k });
        }
      });

      it('in onlyVia does not cover the public path', async () => {
        const ir = banned(['user', 'user:*']);
        for (const holder of ['tenant#member', 'role:member']) {
          const v = await verdictOf(ir, ({ onlyVia }) => onlyVia('tenant:enter', [holder]), k);
          expect(v.result, holder).to.eq('violated');
          expect(publicMember(v), holder).to.eq(true);
        }
        for (const holders of [['tenant#member', 'public'], ['role:member', 'public:tenant#member']]) expect(await verdictOf(ir, ({ onlyVia }) => onlyVia('tenant:enter', holders), k), holders.join()).to.include({ result: 'holds', bound: k });
        expect(await verdictOf(banned(['user']), ({ onlyVia }) => onlyVia('tenant:enter', ['tenant#member']), k)).to.include({ result: 'holds', bound: k });
      });

      it('in never still counts a public member as that holder', async () => {
        // Named members only under a condition no context meets, so only the public member can enter.
        const ir = banned([{ type: 'user', caveat: 'nobody' }, 'user:*'], { nobody: { params: { 'env.n': 'int' }, expr: { all: [{ attr: 'env.n', gt: 3 }, { attr: 'env.n', lt: 4 }] } } });
        for (const holder of ['tenant#member', 'role:member']) {
          const v = await verdictOf(ir, ({ never }) => never({ holder, permission: 'tenant:enter' }), k);
          expect(v.result, holder).to.eq('violated');
          expect(publicMember(v), holder).to.eq(true);
        }
      });
    });
  }
});
