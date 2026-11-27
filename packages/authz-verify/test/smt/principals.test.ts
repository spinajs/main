import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';

import type { PolicyIR } from '@spinajs/authz-ir';
import { bounded, defineAssertions, principalTypes, releaseSolver, universes, verifyAssertions } from '../../src/index.js';
import type { AssertionResult, SatSolver } from '../../src/index.js';
import { z3Solver } from '../../src/smt/z3.js';
import { abacIR } from '../fixtures/abac.js';

const isPolicyIR = (v: unknown): v is PolicyIR => typeof v === 'object' && v !== null && 'version' in v && 'types' in v && 'permissions' in v && 'principal' in v;

/**
 * The compiler's golden (authz-rbac's test/ir.test.ts keeps the file equal to `rbacToIR` merged with its scopes):
 * it names `user` in `allowed` lists only and declares no `user` type.
 */
function compiledRbac(): PolicyIR {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../../../authz-rbac/test/fixtures/invoice.ir.json', import.meta.url), 'utf8'));
  if (!isPolicyIR(parsed)) throw new TypeError('authz-rbac/test/fixtures/invoice.ir.json is not a policy IR');
  return parsed;
}

const notAsked: SatSolver = { solve: () => Promise.reject(new Error('the solver was asked although there is nothing to search')) };

describe('the bounded engine and principal types the IR does not declare', () => {
  it('searches users in the compiled RBAC policy, which declares no user type', () => {
    const ir = compiledRbac();
    expect(Object.keys(ir.types).sort()).to.deep.equal(['$global', 'invoice', 'org', 'project']);
    expect(principalTypes(ir)).to.deep.equal(['org', 'project', 'user']);
    expect(universes(ir, 2, 'invoice').map((u) => `${u.principal.type}:${u.principal.id} -> ${u.resource.type}:${u.resource.id}`)).to.deep.equal(['org:o1 -> invoice:i1', 'project:p1 -> invoice:i1', 'user:u1 -> invoice:i1']);
  });

  it('answers unknown, never holds, when there is nothing to search', async () => {
    const options = { k: 2, solver: () => Promise.resolve(notAsked) };
    const noPrincipal = await bounded(abacIR(), { checks: [{ permission: 'doc:update', allowed: true }] }, options);
    expect([noPrincipal.result, noPrincipal.message]).to.deep.equal(['unknown', 'no relation of the IR names a principal type, so there is no principal to search with']);
    const ir = compiledRbac();
    ir.permissions['note:read'] = { type: 'note', relation: 'read', list: false, source: { origin: 'test' } };
    const noResource = await bounded(ir, { checks: [{ permission: 'note:read', allowed: true }] }, options);
    expect([noResource.result, noResource.message]).to.deep.equal(['unknown', 'the IR declares no type note, so there is no resource to search on']);
  });
});

describe('the bounded engine on the compiled RBAC policy, with z3', function () {
  this.timeout(60_000);
  let z3: SatSolver | undefined;

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: the bounded checks on the compiled RBAC policy are skipped');
      this.skip();
    }
  });

  after(() => releaseSolver());

  const onlyVia = (holders: string[]): Promise<AssertionResult[]> => verifyAssertions(compiledRbac(), defineAssertions((kit) => [kit.onlyVia('invoice:read', holders)]), { k: 2, solver: () => Promise.resolve(z3) });

  it('finds the clerk who reads the invoice she owns: onlyVia(invoice:read, [role:accountant]) is violated', async () => {
    const [r] = await onlyVia(['role:accountant']);
    expect([r.verdict.result, r.verdict.engine, r.diagnostics[0]?.code]).to.deep.equal(['violated', 'bounded', 'AZV001']);
    expect(r.verdict.counterexample?.principal).to.deep.equal({ type: 'user', id: 'u1' });
    expect(r.verdict.counterexample?.outcome).to.deep.equal({ 'invoice:read': 'allow' });
    // Read from the IR, because z-29 renames role relations (role__clerk) and regenerates the golden.
    const clerk = Object.entries(compiledRbac().principal.roles).filter(([role]) => role === 'clerk').flatMap(([, places]) => places.map((p) => p.relation));
    expect(r.verdict.counterexample?.tuples.map((t) => t.relation)).to.include.members([...clerk, 'owner']);
  });

  it('still proves what holds: onlyVia(invoice:read, [role:accountant, role:clerk])', async () => {
    const [r] = await onlyVia(['role:accountant', 'role:clerk']);
    expect(r.verdict).to.deep.include({ result: 'holds', engine: 'bounded', bound: 2 });
  });
});
