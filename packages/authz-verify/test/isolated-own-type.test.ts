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
});
