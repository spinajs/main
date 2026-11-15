import 'mocha';
import { expect } from 'chai';

import type { PolicyIR } from '@spinajs/authz-ir';
import { bounded, releaseSolver } from '../../src/index.js';
import type { BoundedQuery, SatSolver, Verdict } from '../../src/index.js';
import { z3Solver } from '../../src/smt/z3.js';
import { foldersIR, invoicesIR } from '../fixtures/invoices.js';

const implies = (a: string, b: string): BoundedQuery => ({ checks: [{ permission: a, allowed: true }, { permission: b, allowed: false }] });

/** The invoices policy with a plain exclusion instead of the caveated `frozen` one. */
function bannedInvoices(): PolicyIR {
  const ir = invoicesIR();
  delete ir.types.invoice.relations.frozen;
  ir.types.invoice.relations.banned = { allowed: ['user'], source: { kind: 'tuples', store: 't' } };
  ir.types.invoice.permissions.update = { exclusion: { base: { computed: 'approve' }, subtract: { computed: 'banned' } } };
  return ir;
}

describe('bounded engine', function () {
  this.timeout(60_000);
  let z3: SatSolver | undefined;

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: bounded engine tests skipped');
      this.skip();
    }
  });

  after(() => releaseSolver());

  const run = (ir: PolicyIR, q: BoundedQuery, options: { k?: number; attempts?: number; solver?: () => Promise<SatSolver | undefined> } = {}): Promise<Verdict> => bounded(ir, q, { k: 2, solver: () => Promise.resolve(z3), ...options });

  it('finds a counterexample through an intersection and confirms it with the evaluator', async () => {
    const v = await run(invoicesIR(), implies('invoice:read', 'invoice:approve'));
    expect(v).to.deep.include({ result: 'violated', engine: 'bounded', bound: 2 });
    expect(v.counterexample!.outcome).to.deep.equal({ 'invoice:read': 'allow', 'invoice:approve': 'deny' });
    expect(v.counterexample!.principal).to.deep.equal({ type: 'user', id: 'u1' });
  });

  it('verifies up to the bound when no counterexample exists', async () => {
    expect(await run(invoicesIR(), implies('invoice:approve', 'invoice:read'))).to.deep.equal({ result: 'holds', engine: 'bounded', bound: 2, opaque: [] });
    expect((await run(bannedInvoices(), implies('invoice:update', 'invoice:approve'))).result).to.equal('holds');
  });

  it('subtracts exclusions', async () => {
    const v = await run(bannedInvoices(), implies('invoice:approve', 'invoice:update'));
    expect(v.result).to.equal('violated');
    expect(v.counterexample!.tuples.some((t) => t.relation === 'banned')).to.equal(true);
  });

  it('follows first-applicable priority chains', async () => {
    const ir = foldersIR();
    ir.types.folder.permissions.view = { priority: [{ when: { computed: 'edit' }, then: 'deny' }, { when: { computed: 'viewer' }, then: 'permit' }] };
    expect((await run(ir, implies('folder:read', 'folder:browse'))).result).to.equal('holds');
    const v = await run(ir, implies('folder:browse', 'folder:read'));
    expect(v.result).to.equal('violated');
    expect(v.counterexample!.outcome).to.deep.equal({ 'folder:browse': 'allow', 'folder:read': 'deny' });
  });

  it('answers unknown on parts it does not encode', async () => {
    const ir = foldersIR();
    ir.types.folder.permissions.browse = { union: [{ opaque: 'model:legacy' }, { computed: 'viewer' }] };
    const v = await run(ir, implies('folder:browse', 'folder:read'));
    expect(v.result).to.equal('unknown');
    expect(v.message).to.match(/opaque/);
  });

  it('blocks a model the evaluator rejects and asks again', async () => {
    let lies = 0;
    // Lies once, in the universe whose principal is user:u1, where a real counterexample exists.
    const liar: SatSolver = {
      solve: (defs, formulas) => (lies === 0 && JSON.stringify([...defs.values()]).includes('@user:u1') && ++lies ? Promise.resolve({ holds: new Set<string>(), values: new Map<string, number>() }) : z3!.solve(defs, formulas)),
    };
    const v = await run(invoicesIR(), implies('invoice:read', 'invoice:approve'), { solver: () => Promise.resolve(liar) });
    expect(v.result).to.equal('violated');
    expect(lies).to.equal(1);
    lies = 0;
    expect((await run(invoicesIR(), implies('invoice:read', 'invoice:approve'), { solver: () => Promise.resolve(liar), attempts: 1 })).result).to.equal('unknown');
  });
});

describe('bounded engine without a solver', () => {
  it('reports AZV090', async () => {
    const v = await bounded(invoicesIR(), implies('invoice:read', 'invoice:approve'), { solver: () => Promise.resolve(undefined) });
    expect(v).to.deep.include({ result: 'unknown', engine: 'bounded', code: 'AZV090' });
  });
});
