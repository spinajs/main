import { expect } from 'chai';
import 'mocha';
import type { PolicyIR } from '@spinajs/authz-ir';

import { defineAssertions, describeAssertion, outcome, releaseSolver, verifyAssertions } from '../src/index.js';
import type { AssertionResult, SatSolver } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';
import { foldersIR, invoicesIR } from './fixtures/invoices.js';

const noSolver = { solver: () => Promise.resolve(undefined) };

/** foldersIR with principal narrowing compiled in: `edit` is part of `view`, so update implies read for every unnarrowed principal. */
function narrowable(): PolicyIR {
  const ir = foldersIR();
  ir.principal = { ...ir.principal, ceiling: true, delegation: true };
  return ir;
}

/** narrowable() with a deny role: `banned` is subtracted from `view`, and both `edit` and `banned` are roles a ceiling can name. */
function deniable(): PolicyIR {
  const ir = narrowable();
  ir.types.folder.relations.banned = { allowed: ['user'], source: { kind: 'tuples', store: 'authz_assignment' } };
  ir.types.folder.permissions.shown = { exclusion: { base: { computed: 'view' }, subtract: { computed: 'banned' } } };
  ir.permissions['folder:read'] = { ...ir.permissions['folder:read'], relation: 'shown' };
  ir.principal = { ...ir.principal, roles: { editor: [{ type: 'folder', relation: 'edit' }], banned: [{ type: 'folder', relation: 'banned' }] } };
  return ir;
}

const codes = (r: AssertionResult[]): string[][] => r.flatMap((x) => x.diagnostics.map((d) => [d.code, d.severity]));

describe('principal narrowing (G6)', () => {
  it('a policy without a ceiling gets no AZV004, and one with delegation only neither', async () => {
    const set = defineAssertions(({ implies }) => [implies('folder:update', 'folder:read')]);
    expect(codes(await verifyAssertions(foldersIR(), set, noSolver))).to.deep.equal([['AZV002', 'info']]);
    const delegating = foldersIR();
    delegating.principal = { ...delegating.principal, delegation: true };
    expect(codes(await verifyAssertions(delegating, set, noSolver))).to.deep.equal([['AZV002', 'info']]);
  });

  it('an implies that holds says it holds for principals without a ceiling', async () => {
    const r = await verifyAssertions(narrowable(), defineAssertions(({ implies }) => [implies('folder:update', 'folder:read')]), noSolver);
    expect(codes(r)).to.deep.equal([
      ['AZV002', 'info'],
      ['AZV004', 'info'],
    ]);
    expect(r[0].diagnostics[1].message).to.equal('holds for principals without a ceiling: a ceiling whose permissions list folder:update and not folder:read denies folder:read where folder:update stays allowed (implies(a, b, { narrowed: true }) checks it)');
  });

  it('implies(a, b, { narrowed: true }) is violated by a ceiling, with a confirmed counterexample', async () => {
    const set = defineAssertions(({ implies }) => [implies('folder:update', 'folder:read', { narrowed: true })]);
    expect(describeAssertion(set.assertions[0])).to.equal('implies(folder:update, folder:read, narrowed)');
    const r = await verifyAssertions(narrowable(), set, noSolver);
    expect(codes(r)).to.deep.equal([['AZV001', 'error']]);
    expect(r[0].verdict.counterexample?.principal.ceiling).to.deep.equal({ permissions: ['folder:update'] });
    expect(r[0].verdict.counterexample?.outcome).to.deep.equal({ 'folder:update': 'allow', 'folder:read': 'deny' });
  });

  it('narrowed: true changes nothing where the policy compiles no ceiling or nothing reaches a', async () => {
    const plain = await verifyAssertions(foldersIR(), defineAssertions(({ implies }) => [implies('folder:update', 'folder:read', { narrowed: true })]), noSolver);
    expect(codes(plain)).to.deep.equal([['AZV002', 'info']]);
    const unbound = await verifyAssertions(narrowable(), defineAssertions(({ implies }) => [implies('folder:delete', 'folder:read', { narrowed: true })]), noSolver);
    expect(codes(unbound)).to.deep.equal([['AZV002', 'info']]);
  });

  it('narrowed: true does not turn a permission that only conditional paths reach into holds: without a solver it is not verified', async () => {
    // invoice:update is `approve` minus `frozen`: every path to it is conditional, so the exact engine has no witness.
    const r = await verifyAssertions(invoicesIR(), defineAssertions(({ implies }) => [implies('invoice:update', 'invoice:approve', { narrowed: true })]), noSolver);
    expect(r[0].verdict.result).to.equal('unknown');
    expect(codes(r)).to.deep.equal([['AZV090', 'warning']]);
  });

  it('never stays as it is: narrowing only removes allows', async () => {
    const r = await verifyAssertions(narrowable(), defineAssertions(({ never }) => [never({ holder: 'folder#edit', permission: 'folder:browse' })]), noSolver);
    expect(codes(r)).to.deep.equal([['AZV002', 'info']]);
  });

  it('rests on the evaluator: a ceiling over roles keeps a deny role, and inherit answers for the delegate', async () => {
    const ir = deniable();
    const f1 = { type: 'folder', id: 'f1' };
    const u1 = { type: 'user', id: 'u1' };
    const tuples = [
      { object: f1, relation: 'edit', subject: u1 },
      { object: f1, relation: 'banned', subject: u1 },
    ];
    const read = async (roles?: string[]) => (await outcome(ir, { principal: roles === undefined ? u1 : { ...u1, ceiling: { roles } }, resource: f1, tuples }, ['folder:read']))['folder:read'];
    expect(await read()).to.equal('deny');
    expect(await read(['editor'])).to.equal('deny');
    expect(await read([])).to.equal('deny');
    const agent = { type: 'agent', id: 'a1', onBehalfOf: u1, delegation: 'inherit' as const };
    expect(await outcome(ir, { principal: agent, resource: f1, tuples }, ['folder:update', 'folder:read'])).to.deep.equal({ 'folder:update': 'allow', 'folder:read': 'deny' });
  });
});

describe('principal narrowing with the bounded engine', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: bounded narrowing test skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  it('finds the ceiling counterexample of a permission that only conditional paths reach', async () => {
    const set = defineAssertions(({ implies }) => [implies('invoice:update', 'invoice:approve'), implies('invoice:update', 'invoice:approve', { narrowed: true })]);
    const r = await verifyAssertions(invoicesIR(), set, { k: 2, solver: () => Promise.resolve(z3) });
    expect(r.map((x) => [x.verdict.result, x.verdict.engine])).to.deep.equal([
      ['holds', 'bounded'],
      ['violated', 'bounded'],
    ]);
    expect(r[1].verdict.counterexample?.principal.ceiling).to.deep.equal({ permissions: ['invoice:update'] });
    expect(r[1].verdict.counterexample?.outcome).to.deep.equal({ 'invoice:update': 'allow', 'invoice:approve': 'deny' });
  });
});
