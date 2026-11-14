import 'mocha';
import { expect } from 'chai';

import { ACCEPT, RewriteAutomaton, holderKey, letterKey } from '../src/index.js';
import type { Edge } from '../src/index.js';
import { docsIR } from './fixtures/docs.js';
import { foldersIR, invoicesIR } from './fixtures/invoices.js';

/** `via target [letter] ?` where `?` marks a conditional edge. */
const show = (e: Edge): string => `${e.via} ${e.to === ACCEPT ? 'accept' : e.to}${e.letter === undefined ? '' : ` [${letterKey(e.letter)}]`}${e.conditional ? ' ?' : ''}`;
const edges = (a: RewriteAutomaton, state: string): string[] => a.edges(state).map(show);

describe('RewriteAutomaton', () => {
  it('starts a permission at its bound relation and nowhere for an unbound one', () => {
    const a = new RewriteAutomaton(docsIR());
    expect(a.start('doc:read')).to.equal('doc#view');
    expect(a.start('doc:delete')).to.equal(undefined);
  });

  it('reads computed, tuple-to-userset and stored edges, marking exclusion and caveats conditional', () => {
    const a = new RewriteAutomaton(docsIR());
    expect(edges(a, 'doc#view')).to.deep.equal(['computed doc#edit ?', 'ttu folder#view [doc#parent@folder] ?']);
    expect(edges(a, 'doc#edit')).to.deep.equal(['computed doc#owner', 'computed doc#editor']);
    expect(edges(a, 'doc#publish')).to.deep.equal(['computed doc#edit ?']);
    expect(edges(a, 'doc#editor')).to.deep.equal(['direct accept [doc#editor@user]', 'direct accept [doc#editor@user[office_hours]] ?']);
    expect(edges(a, 'folder#viewer')).to.deep.equal(['direct accept [folder#viewer@user]', 'direct group#member [folder#viewer@group#member]', 'direct accept [folder#viewer@user:*]']);
    expect(edges(a, 'folder#view')).to.deep.equal(['computed folder#viewer', 'computed folder#owner', 'ttu $global#admin [folder#parent@$global]']);
  });

  it('gives column relations direct subjects only', () => {
    const ir = invoicesIR();
    ir.types.invoice.relations.owner.allowed = ['user', 'user:*', 'group#member'];
    expect(edges(new RewriteAutomaton(ir), 'invoice#owner')).to.deep.equal(['direct accept [invoice#owner@user]']);
  });

  it('keeps recursive parent rewrites as cycles', () => {
    const a = new RewriteAutomaton(foldersIR());
    expect(edges(a, 'folder#edit')).to.deep.equal(['direct accept [folder#edit@user]', 'ttu folder#edit [folder#parent@folder]']);
  });

  it('stays on the object through a self tupleset and accepts the object itself through a self relation', () => {
    const ir = foldersIR();
    ir.types.folder.relations.me = { allowed: ['folder', 'user'], source: { kind: 'self' } };
    ir.types.folder.permissions.mine = { tupleToUserset: { tupleset: 'me', computed: 'viewer' } };
    const a = new RewriteAutomaton(ir);
    expect(edges(a, 'folder#mine')).to.deep.equal(['ttu folder#viewer']);
    expect(edges(a, 'folder#me')).to.deep.equal(['direct accept']);
  });

  it('records opaque rewrites and follows only the permit side of a priority chain', () => {
    const ir = foldersIR();
    ir.types.folder.permissions.view = { priority: [{ when: { computed: 'edit' }, then: 'deny' }, { when: { computed: 'viewer' }, then: 'permit' }] };
    ir.types.folder.permissions.browse = { union: [{ opaque: 'model:legacy' }, { computed: 'viewer' }] };
    const a = new RewriteAutomaton(ir);
    expect(edges(a, 'folder#view')).to.deep.equal(['computed folder#viewer ?']);
    expect(a.opaqueAt('folder#browse')).to.deep.equal(['model:legacy']);
  });

  it('names role holders by role and wildcard holders as public', () => {
    const a = new RewriteAutomaton(invoicesIR());
    const [accountant] = a.edges('org#accountant');
    expect(holderKey(a.holder(accountant, false))).to.equal('role:accountant@org');
    const [viewer] = new RewriteAutomaton(foldersIR()).edges('folder#viewer');
    expect(holderKey(new RewriteAutomaton(foldersIR()).holder(viewer, true))).to.equal('public:folder#viewer');
    expect(holderKey(new RewriteAutomaton(foldersIR()).holder(viewer, false))).to.equal('folder#viewer');
  });
});
