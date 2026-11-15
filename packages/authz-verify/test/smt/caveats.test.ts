import 'mocha';
import { expect } from 'chai';

import type { Condition } from '@spinajs/authz';
import type { CaveatParamType, PolicyIR } from '@spinajs/authz-ir';
import { CaveatEncoder, bounded, releaseSolver } from '../../src/index.js';
import type { BoundedQuery, SatSolver, Verdict } from '../../src/index.js';
import { z3Solver } from '../../src/smt/z3.js';
import { docsIR } from '../fixtures/docs.js';
import { foldersIR, invoicesIR } from '../fixtures/invoices.js';

const implies = (a: string, b: string): BoundedQuery => ({ checks: [{ permission: a, allowed: true }, { permission: b, allowed: false }] });
const allowed = (p: string): BoundedQuery => ({ checks: [{ permission: p, allowed: true }] });

/** `folder:read` = viewer under one caveat. */
function caveated(expr: Condition, params: Record<string, CaveatParamType> = {}): PolicyIR {
  const ir = foldersIR();
  ir.caveats.c = { params, expr };
  ir.types.folder.permissions.view = { caveat: 'c', of: { computed: 'viewer' } };
  return ir;
}

describe('caveat encoding', () => {
  it('reads comparisons as arithmetic over context variables', () => {
    const e = new CaveatEncoder(docsIR());
    expect(e.formula('office_hours')).to.deep.equal({ and: [{ cmp: 'le', a: 9, b: { num: 'c:env.hour', real: false } }, { cmp: 'lt', a: { num: 'c:env.hour', real: false }, b: 17 }] });
    expect(e.formula('not_frozen')).to.deep.equal({ not: { cmp: 'eq', a: { num: 'c:resource.status', real: false }, b: 1 } });
  });

  it('realises a model as the request context, strings outside the literals as fresh values', () => {
    const e = new CaveatEncoder(docsIR());
    e.formula('office_hours');
    e.formula('not_frozen');
    expect(e.context({ holds: new Set(), values: new Map([['c:env.hour', 10], ['c:resource.status', 1]]) })).to.deep.equal({ env: { hour: 10 }, resource: { status: 'frozen' } });
    expect(e.context({ holds: new Set(), values: new Map([['c:resource.status', 7]]) })).to.deep.include({ resource: { status: '~7' } });
  });

  it('keeps condition functions and pattern operators uninterpreted and opaque', () => {
    const e = new CaveatEncoder(caveated({ any: [{ fn: 'ip.in', args: {} }, { attr: 'resource.name', glob: 'a*' }] }));
    expect(e.formula('c')).to.deep.equal({ or: [{ var: 'u:1' }, { var: 'u:2' }] });
    expect(e.opaque).to.deep.equal([{ kind: 'condition-function', name: 'ip.in' }, { kind: 'condition-function', name: 'resource.name glob' }]);
  });
});

describe('bounded engine with caveats', function () {
  this.timeout(60_000);
  let z3: SatSolver | undefined;
  const run = (ir: PolicyIR, q: BoundedQuery): Promise<Verdict> => bounded(ir, q, { k: 2, solver: () => Promise.resolve(z3) });

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: bounded caveat tests skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  it('finds the context that subtracts a caveated exclusion', async () => {
    const v = await run(invoicesIR(), implies('invoice:approve', 'invoice:update'));
    expect(v.result).to.equal('violated');
    expect(v.counterexample!.context).to.deep.equal({ resource: { status: 'frozen' } });
    expect(v.counterexample!.tuples.map((t) => `${t.object.type}#${t.relation}@${t.subject.type}:${t.subject.id}`)).to.include('invoice#frozen@user:*');
    expect(v.counterexample!.outcome).to.deep.equal({ 'invoice:approve': 'allow', 'invoice:update': 'deny' });
  });

  it('encodes caveat rewrites and conditional tuples', async () => {
    const publish = await run(docsIR(), implies('doc:update', 'doc:publish'));
    expect(publish.result).to.equal('violated');
    expect(publish.counterexample!.context).to.deep.include({ resource: { status: 'frozen' } });
    expect(publish.counterexample!.outcome).to.deep.equal({ 'doc:update': 'allow', 'doc:publish': 'deny' });
    expect((await run(docsIR(), implies('doc:publish', 'doc:update'))).result).to.equal('holds');
  });

  it('solves integer, real, list, boolean and reference comparisons the way the evaluator reads them', async () => {
    const cases: Array<[Condition, Record<string, CaveatParamType>]> = [
      [{ all: [{ attr: 'resource.n', gt: 3 }, { attr: 'resource.n', lt: 5 }] }, { 'resource.n': 'int' }],
      [{ attr: 'env.score', gte: 2.5 }, { 'env.score': 'double' }],
      [{ attr: 'principal.dept', in: ['ops', 'fin'] }, { 'principal.dept': 'string' }],
      [{ all: [{ attr: 'env.flag', eq: true }, { attr: 'env.mode', ne: 'off' }] }, { 'env.flag': 'bool', 'env.mode': 'string' }],
      [{ attr: 'resource.a', eq: { ref: 'principal.b' } }, { 'resource.a': 'int', 'principal.b': 'int' }],
    ];
    for (const [expr, params] of cases) {
      const v = await run(caveated(expr, params), allowed('folder:read'));
      expect(v.result, JSON.stringify(expr)).to.equal('violated');
      expect(v.counterexample!.outcome['folder:read']).to.equal('allow');
    }
    expect((await run(caveated({ all: [{ attr: 'resource.n', gt: 3 }, { attr: 'resource.n', lt: 4 }] }, { 'resource.n': 'int' }), allowed('folder:read'))).result).to.equal('holds');
  });

  it('lists uninterpreted predicates as opaque and never reports a model the evaluator rejects', async () => {
    const v = await run(caveated({ fn: 'ip.in', args: {} }), allowed('folder:read'));
    expect(v.result).to.equal('unknown');
    expect(v.opaque).to.deep.include({ kind: 'condition-function', name: 'ip.in' });
  });
});
