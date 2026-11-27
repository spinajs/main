import 'mocha';
import { expect } from 'chai';

import { validateIR } from '@spinajs/authz-ir';
import type { PolicyIR } from '@spinajs/authz-ir';
import { ACCEPT, ANYONE, Encoder, RewriteAutomaton, Unsupported, defineAssertions, permissionMatrix, releaseSolver, universes, verifyAssertion } from '../src/index.js';
import type { SatSolver } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';
import { invoicesIR } from './fixtures/invoices.js';

/**
 * The invoices policy without `invoice#owner`, which `invoice:read` still names: the shape RBAC compiles before z-42
 * for a relation grant on a relation only a RelationResolver answers (the file ACL). `union` makes the read monotone.
 */
function dangling(read: 'union' | 'intersection'): PolicyIR {
  const ir = invoicesIR();
  delete ir.types.invoice.relations.owner;
  if (read === 'union') ir.types.invoice.permissions.read = { union: [{ tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_read' } }, { computed: 'owner' }] };
  return ir;
}

const notAsked: SatSolver = { solve: () => Promise.reject(new Error('the solver was asked about an IR the encoder refuses')) };
const options = { k: 2, solver: () => Promise.resolve(notAsked) };
const [accountantsOnly] = defineAssertions(({ onlyVia }) => [onlyVia('invoice:read', ['role:accountant'])]).assertions;
const MESSAGE = 'invoice#owner is not defined in the IR';
const viaParent = { tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_read' } };

describe('a rewrite that names a relation the IR does not define', () => {
  it('is a part the exact engine cannot see, so onlyVia is not proved', async () => {
    const ir = dangling('union');
    expect(validateIR(ir).map((d) => d.code)).to.include('IR001');
    expect(new RewriteAutomaton(ir).opaqueAt('invoice#owner')).to.deep.equal(['undefined invoice#owner']);
    const v = await verifyAssertion(ir, accountantsOnly, options);
    expect([v.result, v.engine, v.message]).to.deep.equal(['unknown', 'bounded', MESSAGE]);
    expect(v.opaque).to.deep.include({ kind: 'rewrite', name: 'undefined invoice#owner' });
    const [publicNever] = defineAssertions(({ never }) => [never({ holder: 'public', permission: 'invoice:read' })]).assertions;
    const n = await verifyAssertion(ir, publicNever, options);
    expect([n.result, n.engine, n.message]).to.deep.equal(['unknown', 'bounded', MESSAGE]);
    expect(n.opaque).to.deep.include({ kind: 'rewrite', name: 'undefined invoice#owner' });
  });

  it('leaves never unproved where the only path to the permission runs through it', async () => {
    const ir = dangling('intersection');
    ir.types.invoice.permissions.read = { computed: 'owner' };
    const holders = defineAssertions(({ never }) => [never({ holder: 'public', permission: 'invoice:read' }), never({ holder: 'role:clerk', permission: 'invoice:read' })]).assertions;
    for (const a of holders) {
      const v = await verifyAssertion(ir, a, options);
      expect([v.result, v.engine, v.message], a.kind === 'never' ? a.holder : '').to.deep.equal(['unknown', 'bounded', MESSAGE]);
    }
  });

  it('leaves never proved for a permission that does not reach the undefined name', async () => {
    const ir = invoicesIR();
    ir.types.invoice.permissions.audit = { computed: 'nosuch' };
    ir.permissions['invoice:audit'] = { type: 'invoice', relation: 'audit', list: false, source: { origin: 'config:authz' } };
    const [read, audit] = defineAssertions(({ never }) => [never({ holder: 'public', permission: 'invoice:read' }), never({ holder: 'public', permission: 'invoice:audit' })]).assertions;
    expect(await verifyAssertion(ir, read, options)).to.deep.equal({ result: 'holds', engine: 'exact', opaque: [] });
    expect((await verifyAssertion(ir, audit, options)).message).to.equal('invoice#nosuch is not defined in the IR');
  });

  it('is refused by the bounded engine under an intersection, as RBAC compiles a relation grant', async () => {
    const ir = dangling('intersection');
    const [user] = universes(ir, 2, 'invoice').filter((u) => u.principal.type === 'user');
    expect(() => new Encoder(ir, user, { maxDepth: 8 }).check('invoice:read')).to.throw(Unsupported, MESSAGE);
    const v = await verifyAssertion(ir, accountantsOnly, options);
    expect([v.result, v.message]).to.deep.equal(['unknown', MESSAGE]);
  });

  it('is out of sight as stored tuples, a tupleset, the target of an arrow, the relation a permission is bound to and a subject set of an undeclared type', async () => {
    const cases: ReadonlyArray<readonly [string, (ir: PolicyIR) => void]> = [
      ['invoice#read', (ir) => (ir.types.invoice.permissions.read = { union: [viaParent, { this: true }] })],
      ['invoice#reviewer', (ir) => (ir.types.invoice.permissions.read = { union: [viaParent, { tupleToUserset: { tupleset: 'reviewer', computed: 'can_invoice_read' } }] })],
      ['project#auditor', (ir) => (ir.types.invoice.permissions.read = { union: [viaParent, { tupleToUserset: { tupleset: 'parent', computed: 'auditor' } }] })],
      ['invoice#reader', (ir) => (ir.permissions['invoice:read'] = { ...ir.permissions['invoice:read'], relation: 'reader' })],
      [
        'ghost#member',
        (ir) => {
          ir.types.invoice.relations.reviewer = { allowed: ['ghost#member'], source: { kind: 'tuples', store: 'authz_rebac_tuple' } };
          ir.types.invoice.permissions.read = { union: [viaParent, { computed: 'reviewer' }] };
        },
      ],
    ];
    const [publicNever] = defineAssertions(({ never }) => [never({ holder: 'public', permission: 'invoice:read' })]).assertions;
    for (const [name, edit] of cases) {
      const ir = invoicesIR();
      edit(ir);
      expect(validateIR(ir), name).to.not.deep.equal([]);
      for (const a of [accountantsOnly, publicNever]) {
        const v = await verifyAssertion(ir, a, options);
        expect([v.result, v.message], `${name} ${a.kind}`).to.deep.equal(['unknown', `${name} is not defined in the IR`]);
        expect(v.opaque, `${name} ${a.kind}`).to.deep.include({ kind: 'rewrite', name: `undefined ${name}` });
      }
    }
  });

  it('leaves a policy that defines every name as it was', async () => {
    expect(validateIR(invoicesIR())).to.deep.equal([]);
    expect(permissionMatrix(invoicesIR()).opaque).to.deep.equal({});
    expect([ACCEPT, ANYONE].map((s) => new RewriteAutomaton(invoicesIR()).opaqueAt(s))).to.deep.equal([[], []]);
    const exact = defineAssertions(({ onlyVia, never }) => [onlyVia('invoice:approve', ['role:accountant']), never({ holder: 'public', permission: 'invoice:*' })]).assertions;
    for (const a of exact) expect(await verifyAssertion(invoicesIR(), a, options)).to.deep.equal({ result: 'holds', engine: 'exact', opaque: [] });
  });

  describe('with the real solver', function () {
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

    it('still proves a non-monotone assertion over a policy that defines every name', async () => {
      const [readers] = defineAssertions(({ onlyVia }) => [onlyVia('invoice:read', ['role:accountant', 'role:clerk'])]).assertions;
      expect(await verifyAssertion(invoicesIR(), readers, { k: 2, solver: () => Promise.resolve(z3) })).to.deep.equal({ result: 'holds', engine: 'bounded', bound: 2, opaque: [] });
    });
  });
});
