import 'mocha';
import { expect } from 'chai';

import type { PolicyIR, RelationDef, SubjectTypeRef, TypeDef } from '@spinajs/authz-ir';

import { defineAssertions, releaseSolver, verifyAssertions } from '../src/index.js';
import type { SatSolver, Verdict } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';

const source = { origin: 'config:authz' };
const tuples = (allowed: SubjectTypeRef[]): RelationDef => ({ allowed, source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
const parentOf = (via: string): RelationDef => ({ allowed: [via], source: { kind: 'ancestor', via } });
const bind = (type: string, relation: string) => ({ type, relation, list: false, source });

/** Users enter a tenant as its members; `more` adds types (or replaces `tenant`) and permissions. */
function policy(members: SubjectTypeRef[], more: { types?: Record<string, TypeDef>; permissions?: PolicyIR['permissions']; caveats?: PolicyIR['caveats'] } = {}): PolicyIR {
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
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

/** Documents under tenants that everyone may view. */
const publicDocs = { types: { doc: { relations: { parent: parentOf('tenant'), viewer: tuples(['user:*']) }, permissions: {} } }, permissions: { 'doc:read': bind('doc', 'viewer') } };
const tupleNames = (v: Verdict): string[] => (v.counterexample?.tuples ?? []).map((t) => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}`);

describe('isolated(T) with public grants', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;
  const check = async (ir: PolicyIR, except?: string[]): Promise<Verdict> => {
    const [result] = await verifyAssertions(ir, defineAssertions(({ isolated }) => [isolated('tenant', except === undefined ? {} : { except })]), { k: 2, solver: () => Promise.resolve(z3) });
    return result.verdict;
  };

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
});
