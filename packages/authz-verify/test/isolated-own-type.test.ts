import 'mocha';
import { expect } from 'chai';

import type { PolicyIR } from '@spinajs/authz-ir';

import { defineAssertions, releaseSolver, verifyAssertions } from '../src/index.js';
import type { SatSolver } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';

/** Members of a tenant enter it; with `nested`, the members of one tenant can be made members of another. */
function tenantsIR(nested: boolean): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      $global: { relations: {}, permissions: {} },
      tenant: {
        relations: {
          parent: { allowed: ['$global'], source: { kind: 'ancestor', via: '$global' } },
          member: { allowed: nested ? ['user', 'tenant#member'] : ['user'], source: { kind: 'tuples', store: 'authz_assignment' } },
        },
        permissions: {},
      },
    },
    permissions: { 'tenant:enter': { type: 'tenant', relation: 'member', list: false, source: { origin: 'config:authz' } } },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: { member: [{ type: 'tenant', relation: 'member' }] } },
    opaque: [],
  };
}

/** A user sees its own profile through `@Self()`. */
function selfIR(): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: { self: { allowed: ['user'], source: { kind: 'self' } } }, permissions: {} },
      $global: { relations: {}, permissions: {} },
    },
    permissions: { 'user:profile': { type: 'user', relation: 'self', list: false, source: { origin: 'config:authz' } } },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

/** Tenants are principals: a tenant enters the partners of the tenants it is a member of, and tenants nest. */
function partnerTenantsIR(): PolicyIR {
  const tuples = { kind: 'tuples', store: 'authz_rebac_tuple' } as const;
  return {
    version: 1,
    types: {
      $global: { relations: {}, permissions: {} },
      tenant: {
        relations: {
          parent: { allowed: ['$global', 'tenant'], source: { kind: 'ancestor', via: 'tenant' } },
          member: { allowed: ['tenant'], source: tuples },
          partner: { allowed: ['tenant'], source: tuples },
        },
        permissions: { enter: { union: [{ computed: 'member' }, { tupleToUserset: { tupleset: 'partner', computed: 'member' } }] } },
      },
    },
    permissions: { 'tenant:enter': { type: 'tenant', relation: 'enter', list: false, source: { origin: 'config:authz' } } },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

describe('isolated(T) on a permission of T itself', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;
  const isolatedTenant = defineAssertions(({ isolated }) => [isolated('tenant')]);

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: the isolated(T) tests are skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  it('finds the members of one tenant made members of another', async () => {
    const [result] = await verifyAssertions(tenantsIR(true), isolatedTenant, { k: 2, solver: () => Promise.resolve(z3) });
    expect(result.verdict.result).to.eq('violated');
    expect(result.verdict.counterexample?.tuples.some((t) => t.subject.relation === 'member')).to.eq(true);
  });

  it('holds when only people are members', async () => {
    const [result] = await verifyAssertions(tenantsIR(false), isolatedTenant, { k: 2, solver: () => Promise.resolve(z3) });
    expect(result.verdict).to.include({ result: 'holds', engine: 'bounded', bound: 2 });
  });

  it('is not decided with one tenant in the universe', async () => {
    const [result] = await verifyAssertions(tenantsIR(true), isolatedTenant, { k: 1, solver: () => Promise.resolve(z3) });
    expect(result.verdict).to.include({ result: 'unknown', message: 'isolated(tenant) needs k >= 2' });
  });

  it('holds when a user reaches only itself', async () => {
    const isolatedUser = defineAssertions(({ isolated }) => [isolated('user')]);
    const [result] = await verifyAssertions(selfIR(), isolatedUser, { k: 2, solver: () => Promise.resolve(z3) });
    expect(result.verdict).to.include({ result: 'holds', engine: 'bounded', bound: 2 });
  });

  it('finds a tenant that enters another tenant through a tenant under it', async () => {
    const [result] = await verifyAssertions(partnerTenantsIR(), isolatedTenant, { k: 3, solver: () => Promise.resolve(z3) });
    expect(result.verdict.result).to.eq('violated');
    const cx = result.verdict.counterexample;
    expect(cx?.principal.type).to.eq('tenant');
    expect(cx?.resource.type).to.eq('tenant');
    expect(cx?.principal.id).to.not.eq(cx?.resource.id);
  });
});
