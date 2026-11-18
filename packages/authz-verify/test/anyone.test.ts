import 'mocha';
import { expect } from 'chai';
import type { PolicyIR } from '@spinajs/authz-ir';

import { ANYONE, RewriteAutomaton, accessOf, holderKey, implies, outcome, permissionMatrix, reachers, verifyAssertion } from '../src/index.js';
import { abacIR } from './fixtures/abac.js';
import { invoicesIR } from './fixtures/invoices.js';

const noSolver = { solver: async () => undefined };
const holders = (ir: PolicyIR, permission: string): string[] => reachers(ir, permission).map((r) => `${holderKey(r.holder)}${r.conditional ? ' ?' : ''}`);

/** An account may update itself (a `self` relation), and everyone may read every account. */
function accountsIR(): PolicyIR {
  const source = { origin: 'config:authz' };
  return {
    version: 1,
    types: { account: { relations: { self: { allowed: ['account'], source: { kind: 'self' } } }, permissions: { edit: { computed: 'self' }, view: { intersection: [] } } } },
    permissions: {
      'account:update': { type: 'account', relation: 'edit', list: false, source },
      'account:read': { type: 'account', relation: 'view', list: true, source },
    },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

/** The invoices policy with one more permission, which everyone holds. */
function withOpenList(): PolicyIR {
  const ir = invoicesIR();
  ir.types.invoice.permissions.open = { intersection: [] };
  ir.permissions['invoice:list'] = { type: 'invoice', relation: 'open', list: true, source: { origin: 'config:authz' } };
  return ir;
}

describe('anyone terms (what ABAC compiles to)', () => {
  it('reads an empty intersection as an edge that accepts anyone, conditional under a caveat', () => {
    const a = new RewriteAutomaton(abacIR());
    expect(a.edges('doc#abac_permit_doc_read')).to.deep.equal([{ to: ANYONE, via: 'computed', type: 'doc', relation: 'abac_permit_doc_read', stored: false, conditional: false }]);
    expect(a.edges('doc#abac_permit_doc_update')).to.deep.equal([{ to: ANYONE, via: 'computed', type: 'doc', relation: 'abac_permit_doc_update', stored: false, conditional: true }]);
  });

  it('lists the term as its own holder, with a witness the evaluator allows', async () => {
    expect(holders(abacIR(), 'doc:read')).to.deep.equal(['anyone:doc#abac_permit_doc_read']);
    expect(holders(abacIR(), 'doc:update')).to.deep.equal(['anyone:doc#abac_permit_doc_update ?']);
    expect(holders(abacIR(), 'doc:delete')).to.deep.equal(['anyone:doc#abac_permit_doc_delete ?']);
    const [open] = reachers(abacIR(), 'doc:read');
    expect(open.witness).to.deep.equal({ principal: { type: 'user', id: 'u1' }, resource: { type: 'doc', id: 'd1' }, tuples: [] });
    expect(await outcome(abacIR(), open.witness, ['doc:read'])).to.deep.equal({ 'doc:read': 'allow' });
  });

  it('never(public, permission) is violated where the evaluator allows everyone', async () => {
    const v = await verifyAssertion(abacIR(), { kind: 'never', holder: 'public', permission: 'doc:read' }, noSolver);
    expect([v.result, v.engine]).to.deep.equal(['violated', 'exact']);
    expect(v.counterexample?.tuples).to.deep.equal([]);
    expect(v.counterexample?.outcome).to.deep.equal({ 'doc:read': 'allow' });
  });

  it('never(holder, permission) is violated for any holder: the term needs none', async () => {
    expect((await verifyAssertion(abacIR(), { kind: 'never', holder: 'role:auditor@org', permission: 'doc:read' }, noSolver)).result).to.equal('violated');
  });

  it('a caveated term is not decided without a solver, and says so', async () => {
    const v = await verifyAssertion(abacIR(), { kind: 'never', holder: 'public', permission: 'doc:update' }, noSolver);
    expect([v.result, v.code]).to.deep.equal(['unknown', 'AZV090']);
  });

  it('implies: anyone covers every path, and no path covers anyone', async () => {
    expect((await implies(withOpenList(), 'invoice:approve', 'invoice:list')).result).to.equal('holds');
    const v = await implies(withOpenList(), 'invoice:list', 'invoice:approve');
    expect(v.result).to.equal('violated');
    expect(v.counterexample?.tuples).to.deep.equal([]);
    expect(v.counterexample?.outcome).to.deep.equal({ 'invoice:list': 'allow', 'invoice:approve': 'deny' });
  });

  it('onlyVia and separated see the anyone path', async () => {
    expect((await verifyAssertion(withOpenList(), { kind: 'onlyVia', permission: 'invoice:list', holders: ['role:accountant@org'] }, noSolver)).result).to.equal('violated');
    expect((await verifyAssertion(withOpenList(), { kind: 'onlyVia', permission: 'invoice:list', holders: ['public'] }, noSolver)).result).to.equal('holds');
    const both = await verifyAssertion(withOpenList(), { kind: 'separated', a: 'invoice:approve', b: 'invoice:list', on: 'same-resource' }, noSolver);
    expect([both.result, both.engine]).to.deep.equal(['violated', 'exact']);
    expect(both.counterexample?.outcome).to.deep.equal({ 'invoice:approve': 'allow', 'invoice:list': 'allow' });
  });

  it('separated lays an anyone path on a principal that is the resource itself', async () => {
    const v = await verifyAssertion(accountsIR(), { kind: 'separated', a: 'account:update', b: 'account:read', on: 'same-resource' }, noSolver);
    expect([v.result, v.engine]).to.deep.equal(['violated', 'exact']);
    expect([v.counterexample?.principal, v.counterexample?.resource]).to.deep.equal([{ type: 'account', id: 'a1' }, { type: 'account', id: 'a1' }]);
    expect(v.counterexample?.outcome).to.deep.equal({ 'account:update': 'allow', 'account:read': 'allow' });
  });

  it('onlyVia with a listed anyone term under a condition is not decided, and no solver is asked', async () => {
    const v = await verifyAssertion(abacIR(), { kind: 'onlyVia', permission: 'doc:update', holders: ['public'] }, noSolver);
    expect([v.result, v.engine, v.code]).to.deep.equal(['unknown', 'exact', undefined]);
    expect(v.message).to.equal('onlyVia(doc:update): a listed holder is an anyone term the exact engine cannot decide; the bounded search rules a holder out by its tuples, and an anyone term reads none');
  });

  it('isolated with an anyone term among its exceptions is not decided either', async () => {
    const v = await verifyAssertion(abacIR(), { kind: 'isolated', type: 'doc', except: ['public'] }, noSolver);
    expect([v.result, v.code]).to.deep.equal(['unknown', undefined]);
    expect(v.message).to.contain('isolated(doc): a listed holder is an anyone term');
  });

  it('rates the terms in the permission matrix', () => {
    expect(permissionMatrix(abacIR()).cells).to.deep.equal({
      'anyone:doc#abac_permit_doc_delete': { 'doc:delete': 'conditional', 'doc:read': 'never', 'doc:update': 'never' },
      'anyone:doc#abac_permit_doc_read': { 'doc:delete': 'never', 'doc:read': 'always', 'doc:update': 'never' },
      'anyone:doc#abac_permit_doc_update': { 'doc:delete': 'never', 'doc:read': 'never', 'doc:update': 'conditional' },
    });
    expect(permissionMatrix(abacIR()).everyone).to.deep.equal({ 'doc:delete': 'conditional', 'doc:read': 'always', 'doc:update': 'conditional' });
  });

  it('the matrix and never() agree on what a holder gets where a term holds for everyone', async () => {
    const m = permissionMatrix(withOpenList());
    expect(m.cells['role:accountant@org']['invoice:list']).to.equal('never');
    expect(m.everyone).to.deep.equal({ 'invoice:list': 'always' });
    expect(accessOf(m, 'role:accountant@org', 'invoice:list')).to.equal('always');
    expect(accessOf(m, 'no:such#holder', 'invoice:list')).to.equal('always');
    for (const holder of Object.keys(m.cells)) {
      for (const permission of m.permissions) {
        const v = await verifyAssertion(withOpenList(), { kind: 'never', holder, permission }, noSolver);
        const access = accessOf(m, holder, permission);
        expect([holder, permission, v.result === 'holds'], 'never holds exactly where the matrix says never').to.deep.equal([holder, permission, access === 'never']);
        expect([holder, permission, v.result === 'violated'], 'never is violated exactly where the matrix says always').to.deep.equal([holder, permission, access === 'always']);
      }
    }
  });
});
