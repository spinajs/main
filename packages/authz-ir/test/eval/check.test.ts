import 'mocha';
import { expect } from 'chai';

import { GLOBAL_OBJECT, IREvaluator, MemoryTupleSource } from '../../src/index.js';
import type { EvalInput, IREvaluatorOptions, PolicyIR, Truth } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const user = (id: string) => ({ type: 'user', id });
const doc = (id: string) => ({ type: 'doc', id });
const folder = (id: string) => ({ type: 'folder', id });
const group = (id: string) => ({ type: 'group', id });
const members = (id: string) => ({ type: 'group', id, relation: 'member' });

/** f1 under $global, d1 in f1; group g1 (with nested g2) views f1; u1 edits d1, u2 wrote d1, u3 is in g2, u9 is a global admin. */
function world(ir: PolicyIR = docsIR()): MemoryTupleSource {
  return new MemoryTupleSource(ir)
    .add(folder('f1'), 'parent', GLOBAL_OBJECT)
    .add(folder('f2'), 'parent', GLOBAL_OBJECT)
    .add(folder('f1'), 'viewer', members('g1'))
    .add(group('g1'), 'member', members('g2'))
    .add(group('g2'), 'member', user('u3'))
    .add(doc('d1'), 'editor', user('u1'))
    .add(GLOBAL_OBJECT, 'admin', user('u9'))
    .setColumn('Doc', 'folder_id', doc('d1'), folder('f1'))
    .setColumn('Doc', 'author_id', doc('d1'), user('u2'))
    .setColumn('Doc', 'folder_id', doc('d2'), folder('f2'));
}

async function truth(input: Partial<EvalInput> & { principal: EvalInput['principal'] }, source = world(), ir = docsIR(), options?: IREvaluatorOptions): Promise<Truth> {
  return (await new IREvaluator(ir, source, options).check({ permission: 'doc:read', resource: doc('d1'), ...input })).truth;
}

describe('IREvaluator.check', () => {
  it('follows stored tuples, columns, nested subject sets and tuple-to-userset', async () => {
    expect(await truth({ principal: user('u1'), permission: 'doc:update' })).to.equal('allow');
    expect(await truth({ principal: user('u2'), permission: 'doc:update' })).to.equal('allow');
    expect(await truth({ principal: user('u3'), permission: 'doc:update' })).to.equal('deny');
    expect(await truth({ principal: user('u3') })).to.equal('allow');
    expect(await truth({ principal: user('u4') })).to.equal('deny');
  });

  it('reaches every object from a $global role through the parent chain', async () => {
    expect(await truth({ principal: user('u9') })).to.equal('allow');
    expect(await truth({ principal: user('u9'), permission: 'folder:read', resource: folder('f2') })).to.equal('allow');
    expect(await truth({ principal: user('u9'), permission: 'doc:read', resource: doc('d3') })).to.equal('deny');
  });

  it('subtracts an exclusion and matches the public wildcard', async () => {
    const source = world().add(doc('d1'), 'banned', user('u3')).add(folder('f2'), 'viewer', { type: 'user', id: '*' });
    expect(await truth({ principal: user('u3') }, source)).to.equal('deny');
    expect(await truth({ principal: user('u7'), resource: doc('d2') }, source)).to.equal('allow');
    expect(await truth({ principal: { type: 'agent', id: 'u7' }, resource: doc('d2') }, source)).to.equal('deny');
  });

  it('denies an unbound permission and a resource of another type', async () => {
    expect(await truth({ principal: user('u1'), permission: 'doc:delete' })).to.equal('deny');
    expect(await truth({ principal: user('u1'), resource: folder('f1') })).to.equal('deny');
    let error: unknown;
    try {
      await new IREvaluator(docsIR(), world()).check({ principal: user('u1'), permission: 'doc:read', resource: { type: 'doc' } });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(TypeError);
  });

  it('ends a membership cycle with deny, as ReBAC does', async () => {
    const source = world().add(group('g2'), 'member', members('g1'));
    expect(await truth({ principal: user('u4') }, source)).to.equal('deny');
    expect(await truth({ principal: user('u3') }, source)).to.equal('allow');
  });

  it('answers unknown past maxDepth and maxCalls', async () => {
    const result = await new IREvaluator(docsIR(), world(), { maxDepth: 1 }).check({ principal: user('u3'), permission: 'folder:read', resource: folder('f1') });
    expect(result.truth).to.equal('unknown');
    expect(JSON.stringify(result.tree)).to.contain('maxDepth 1 at group:g2#member');
    expect(await truth({ principal: user('u3') }, world(), docsIR(), { maxCalls: 3 })).to.equal('unknown');
    expect(await truth({ principal: user('u1') }, world(), docsIR(), { maxDepth: 1 })).to.equal('allow');
  });

  it('keeps unknown through an exclusion: unknown base, or a subtract that might hold', async () => {
    const ir = docsIR();
    ir.types.doc.permissions.view = { exclusion: { base: { union: [{ computed: 'edit' }, { opaque: 'custom' }] }, subtract: { computed: 'banned' } } };
    expect(await truth({ principal: user('u4') }, world(), ir)).to.equal('unknown');
    ir.types.doc.permissions.view = { exclusion: { base: { computed: 'edit' }, subtract: { opaque: 'custom' } } };
    expect(await truth({ principal: user('u1') }, world(), ir)).to.equal('unknown');
    expect(await truth({ principal: user('u4') }, world(), ir)).to.equal('deny');
  });

  it('decides priority chains first-applicable, in Kleene logic', async () => {
    const ir = docsIR();
    ir.types.doc.permissions.view = {
      priority: [
        { when: { computed: 'banned' }, then: 'deny' },
        { when: { computed: 'edit' }, then: 'permit' },
      ],
    };
    const source = world().add(doc('d1'), 'banned', user('u2'));
    expect(await truth({ principal: user('u1') }, source, ir)).to.equal('allow');
    expect(await truth({ principal: user('u2') }, source, ir)).to.equal('deny');
    expect(await truth({ principal: user('u4') }, source, ir)).to.equal('deny');
    ir.types.doc.permissions.view = { priority: [{ when: { opaque: 'x' }, then: 'deny' }, ...ir.types.doc.permissions.view.priority] };
    expect(await truth({ principal: user('u1') }, source, ir)).to.equal('unknown');
    expect(await truth({ principal: user('u4') }, source, ir)).to.equal('deny');
  });

  it('explains the decision as a { label, truth, children, source } tree', async () => {
    const { tree } = await new IREvaluator(docsIR(), world()).check({ principal: user('u3'), permission: 'doc:read', resource: doc('d1') });
    expect(tree).to.include({ label: 'user:u3 doc:read doc:d1', truth: 'allow', source: 'permissions.doc:read' });
    const view = tree.children[0];
    expect(view).to.include({ label: 'doc:d1#view', truth: 'allow', source: 'types.doc.permissions.view' });
    const text = JSON.stringify(tree);
    expect(text).to.contain('parent->view').and.to.contain('folder:f1#viewer@group:g1#member').and.to.contain('group:g2#member@user:u3');
  });
});

describe('IREvaluator.check principal narrowing (G6)', () => {
  it('applies the ceiling: permission globs, expiry, resources and roles', async () => {
    const at = new Date('2026-11-04T10:00:00Z');
    expect(await truth({ principal: { ...user('u3'), ceiling: { permissions: ['folder:*'] } } })).to.equal('deny');
    expect(await truth({ principal: { ...user('u3'), ceiling: { permissions: ['doc:*'] } } })).to.equal('allow');
    expect(await truth({ principal: { ...user('u3'), ceiling: { expiresAt: '2026-11-04T09:00:00Z' } }, at })).to.equal('deny');
    expect(await truth({ principal: { ...user('u3'), ceiling: { expiresAt: '2026-11-04T11:00:00Z' } }, at })).to.equal('allow');
    expect(await truth({ principal: { ...user('u9'), ceiling: { resources: [folder('f1')] } } })).to.equal('allow');
    expect(await truth({ principal: { ...user('u9'), ceiling: { resources: [folder('f1')] } }, resource: doc('d2') })).to.equal('deny');
    expect(await truth({ principal: { ...user('u9'), ceiling: { resources: [{ type: '$global' }] } }, resource: doc('d2') })).to.equal('allow');
    expect(await truth({ principal: { ...user('u9'), ceiling: { roles: [] } } })).to.equal('deny');
    expect(await truth({ principal: { ...user('u9'), ceiling: { roles: ['admin'] } } })).to.equal('allow');
  });

  it('ignores ceilings and delegation the IR does not enforce', async () => {
    const ir = docsIR();
    ir.principal.ceiling = false;
    ir.principal.delegation = false;
    expect(await truth({ principal: { ...user('u3'), ceiling: { permissions: [] } } }, world(ir), ir)).to.equal('allow');
    expect(await truth({ principal: { type: 'agent', id: 'a1', onBehalfOf: user('u3') } }, world(ir), ir)).to.equal('deny');
  });

  it('intersects an agent with its delegate, or runs as the delegate under inherit', async () => {
    const agent = { type: 'agent', id: 'a1', onBehalfOf: user('u3') };
    expect(await truth({ principal: agent })).to.equal('deny');
    expect(await truth({ principal: agent }, world().add(folder('f1'), 'viewer', { type: 'agent', id: 'a1' }), docsIR(), undefined)).to.equal('deny');
    const ir = docsIR();
    ir.types.folder.relations.viewer.allowed.push('agent');
    expect(await truth({ principal: agent }, world(ir).add(folder('f1'), 'viewer', { type: 'agent', id: 'a1' }), ir)).to.equal('allow');
    expect(await truth({ principal: { ...agent, delegation: 'inherit' } })).to.equal('allow');
    expect(await truth({ principal: { ...agent, delegation: 'inherit', ceiling: { permissions: ['folder:*'] } } })).to.equal('deny');
    expect(await truth({ principal: { type: 'agent', id: 'a1', onBehalfOf: { type: 'system', id: 'system' }, delegation: 'inherit' } })).to.equal('deny');
  });
});
