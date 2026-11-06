import 'mocha';
import { expect } from 'chai';

import { WitnessRejected, confirm, implies, onlyVia, reachers } from '../src/index.js';
import { docsIR } from './fixtures/docs.js';
import { foldersIR, invoicesIR } from './fixtures/invoices.js';

/** The invoices policy without its non-monotone parts: `read` is `parent->can_invoice_read` only. */
function monotoneInvoices() {
  const ir = invoicesIR();
  ir.types.invoice.permissions.read = { tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_read' } };
  delete ir.permissions['invoice:update'];
  return ir;
}

describe('implies', () => {
  it('holds when every path of the first permission is a path of the second', async () => {
    expect(await implies(monotoneInvoices(), 'invoice:approve', 'invoice:read')).to.deep.equal({ result: 'holds', engine: 'exact', opaque: [] });
    expect((await implies(foldersIR(), 'folder:update', 'folder:read')).result).to.equal('holds');
    expect((await implies(foldersIR(), 'folder:browse', 'folder:read')).result).to.equal('holds');
  });

  it('is violated with the shortest separating witness, confirmed by the evaluator', async () => {
    const ir = monotoneInvoices();
    ir.types.org.relations.reader = { allowed: ['user'], source: { kind: 'tuples', store: 'authz_assignment' } };
    ir.types.org.permissions.can_invoice_read = { union: [{ computed: 'accountant' }, { computed: 'reader' }] };
    const v = await implies(ir, 'invoice:read', 'invoice:approve');
    expect(v.result).to.equal('violated');
    expect(v.engine).to.equal('exact');
    expect(v.counterexample).to.deep.include({
      principal: { type: 'user', id: 'u1' },
      resource: { type: 'invoice', id: 'i1' },
      outcome: { 'invoice:read': 'allow', 'invoice:approve': 'deny' },
    });
    expect(v.counterexample!.tuples.map((t) => `${t.object.type}:${t.object.id}#${t.relation}@${t.subject.type}:${t.subject.id}`)).to.deep.equal(['invoice:i1#parent@project:p1', 'project:p1#parent@org:o1', 'org:o1#reader@user:u1']);
  });

  it('decides recursive chains without unrolling them', async () => {
    const v = await implies(foldersIR(), 'folder:read', 'folder:browse');
    expect(v.result).to.equal('violated');
    expect(v.counterexample!.outcome).to.deep.equal({ 'folder:read': 'allow', 'folder:browse': 'deny' });
    const ir = foldersIR();
    ir.types.folder.permissions.view = { union: [{ computed: 'viewer' }, { tupleToUserset: { tupleset: 'parent', computed: 'browse' } }] };
    expect((await implies(ir, 'folder:read', 'folder:browse')).result).to.equal('holds');
    ir.types.folder.permissions.view = { union: [{ computed: 'viewer' }, { tupleToUserset: { tupleset: 'parent', computed: 'edit' } }] };
    const deep = await implies(ir, 'folder:read', 'folder:browse');
    expect(deep.result).to.equal('violated');
    expect(deep.counterexample!.tuples).to.have.length(2);
  });

  it('separates permissions on different types and unbound permissions', async () => {
    const ir = foldersIR();
    ir.types.doc = { relations: { viewer: { allowed: ['user'], source: { kind: 'tuples', store: 't' } } }, permissions: {} };
    ir.permissions['doc:read'] = { type: 'doc', relation: 'viewer', list: true, source: { origin: 'test' } };
    expect((await implies(ir, 'folder:read', 'doc:read')).result).to.equal('violated');
    expect((await implies(ir, 'folder:read', 'folder:delete')).result).to.equal('violated');
    expect((await implies(ir, 'folder:delete', 'folder:read')).result).to.equal('holds');
  });

  it('confirms the witness of every violated pair of the monotone fixtures', async () => {
    for (const ir of [monotoneInvoices(), foldersIR()]) {
      for (const a of Object.keys(ir.permissions)) {
        for (const b of Object.keys(ir.permissions)) {
          const v = await implies(ir, a, b);
          expect(v.result, `${a} => ${b}`).to.equal(a === b ? 'holds' : v.result);
          if (v.result === 'violated') expect(v.counterexample!.outcome[a]).to.equal('allow');
        }
      }
    }
  });

  it('leaves non-monotone permissions to the bounded engine and lists opaque parts', async () => {
    expect(await implies(docsIR(), 'doc:update', 'doc:read')).to.deep.equal({ result: 'unknown', engine: 'exact', opaque: [] });
    const ir = foldersIR();
    ir.opaque = [{ kind: 'model', name: 'legacy' }];
    ir.types.folder.permissions.browse = { union: [{ opaque: 'model:legacy' }, { computed: 'viewer' }] };
    expect(await implies(ir, 'folder:browse', 'folder:read')).to.deep.equal({ result: 'unknown', engine: 'exact', opaque: [{ kind: 'model', name: 'legacy' }, { kind: 'rewrite', name: 'model:legacy' }] });
  });
});

describe('onlyVia', () => {
  it('holds when every holder is listed, by role or by relation', async () => {
    expect((await onlyVia(monotoneInvoices(), 'invoice:approve', ['role:accountant@org'])).result).to.equal('holds');
    expect((await onlyVia(monotoneInvoices(), 'invoice:approve', ['org#accountant'])).result).to.equal('holds');
    expect((await onlyVia(foldersIR(), 'folder:read', ['folder#viewer', 'folder#edit', 'public'])).result).to.equal('holds');
  });

  it('counts group members of a listed role as holding it', async () => {
    const ir = monotoneInvoices();
    const v = await onlyVia(ir, 'invoice:read', ['role:accountant']);
    expect(v.result).to.equal('holds');
  });

  it('is violated by an unlisted holder, with a confirmed witness', async () => {
    const v = await onlyVia(foldersIR(), 'folder:read', ['folder#viewer', 'folder#edit']);
    expect(v.result).to.equal('violated');
    expect(v.counterexample!.tuples).to.deep.equal([{ object: { type: 'folder', id: 'f1' }, relation: 'viewer', subject: { type: 'user', id: '*' } }]);
    expect(v.counterexample!.outcome).to.deep.equal({ 'folder:read': 'allow' });
  });

  it('is unknown on non-monotone permissions', async () => {
    expect((await onlyVia(invoicesIR(), 'invoice:read', ['role:accountant@org'])).result).to.equal('unknown');
  });
});

describe('witness confirmation', () => {
  it('rejects a witness the reference evaluator does not confirm', async () => {
    const [r] = reachers(foldersIR(), 'folder:update');
    let error: unknown;
    try {
      await confirm(foldersIR(), r.witness, { 'folder:update': 'not-allow' });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(WitnessRejected);
  });
});
