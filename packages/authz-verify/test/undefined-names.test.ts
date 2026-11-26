import 'mocha';
import { expect } from 'chai';

import { validateIR } from '@spinajs/authz-ir';
import type { PolicyIR } from '@spinajs/authz-ir';
import { Encoder, RewriteAutomaton, Unsupported, defineAssertions, permissionMatrix, releaseSolver, universes, verifyAssertion } from '../src/index.js';
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
    // never() with no holder on any path keeps holds, and must carry the part it cannot see (AZV003).
    const [publicNever] = defineAssertions(({ never }) => [never({ holder: 'public', permission: 'invoice:read' })]).assertions;
    const n = await verifyAssertion(ir, publicNever, options);
    expect([n.result, n.engine]).to.deep.equal(['holds', 'exact']);
    expect(n.opaque).to.deep.include({ kind: 'rewrite', name: 'undefined invoice#owner' });
  });

  it('is refused by the bounded engine under an intersection, as RBAC compiles a relation grant', async () => {
    const ir = dangling('intersection');
    const [user] = universes(ir, 2, 'invoice').filter((u) => u.principal.type === 'user');
    expect(() => new Encoder(ir, user, { maxDepth: 8 }).check('invoice:read')).to.throw(Unsupported, MESSAGE);
    const v = await verifyAssertion(ir, accountantsOnly, options);
    expect([v.result, v.message]).to.deep.equal(['unknown', MESSAGE]);
  });

  it('is out of sight as stored tuples, a tupleset, the target of an arrow and the relation a permission is bound to', async () => {
    const cases: ReadonlyArray<readonly [string, (ir: PolicyIR) => void]> = [
      ['invoice#read', (ir) => (ir.types.invoice.permissions.read = { union: [viaParent, { this: true }] })],
      ['invoice#reviewer', (ir) => (ir.types.invoice.permissions.read = { union: [viaParent, { tupleToUserset: { tupleset: 'reviewer', computed: 'can_invoice_read' } }] })],
      ['project#auditor', (ir) => (ir.types.invoice.permissions.read = { union: [viaParent, { tupleToUserset: { tupleset: 'parent', computed: 'auditor' } }] })],
      ['invoice#reader', (ir) => (ir.permissions['invoice:read'] = { ...ir.permissions['invoice:read'], relation: 'reader' })],
    ];
    for (const [name, edit] of cases) {
      const ir = invoicesIR();
      edit(ir);
      expect(validateIR(ir), name).to.not.deep.equal([]);
      const v = await verifyAssertion(ir, accountantsOnly, options);
      expect([v.result, v.message], name).to.deep.equal(['unknown', `${name} is not defined in the IR`]);
      expect(v.opaque, name).to.deep.include({ kind: 'rewrite', name: `undefined ${name}` });
    }
  });

  it('leaves a policy that defines every name as it was', async () => {
    expect(validateIR(invoicesIR())).to.deep.equal([]);
    expect(permissionMatrix(invoicesIR()).opaque).to.deep.equal({});
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
