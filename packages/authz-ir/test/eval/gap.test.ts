import 'mocha';
import { expect } from 'chai';

import { GLOBAL_OBJECT, IREvaluator, MemoryTupleSource } from '../../src/index.js';
import type { CheckResult, EvalInput, ExplainNode, ObjectRef, RelationName, TupleSubjectRef } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';
import { GappedSource } from '../fixtures/gapped.js';

const user = (id: string) => ({ type: 'user', id });
const doc = (id: string) => ({ type: 'doc', id });
const folder = (id: string) => ({ type: 'folder', id });

function world(): MemoryTupleSource {
  return new MemoryTupleSource(docsIR())
    .add(folder('f1'), 'parent', GLOBAL_OBJECT)
    .add(folder('f1'), 'viewer', user('u3'))
    .add(doc('d1'), 'editor', user('u1'))
    .add(doc('d1'), 'editor', user('u4'))
    .add(GLOBAL_OBJECT, 'admin', user('u9'))
    .setColumn('Doc', 'folder_id', doc('d1'), folder('f1'));
}

type Hide = (o: ObjectRef, relation: RelationName, s: TupleSubjectRef) => boolean;

function check(input: Partial<EvalInput> & { principal: EvalInput['principal'] }, gaps: string[], hide?: Hide): Promise<CheckResult> {
  const source = new GappedSource(world(), new Set(gaps), hide);
  return new IREvaluator(docsIR(), source).check({ permission: 'doc:read', resource: doc('d1'), ...input });
}

function nodes(tree: ExplainNode, source: string): ExplainNode[] {
  return [...(tree.source === source ? [tree] : []), ...tree.children.flatMap((c) => nodes(c, source))];
}

const editors = GappedSource.key(doc('d1'), 'editor');
const parents = GappedSource.key(folder('f1'), 'parent');
const folders = GappedSource.key(doc('d1'), 'Doc.folder_id');

describe('IREvaluator.check over a partial read', () => {
  it('lets the known subjects of a stored relation decide, and adds the gap to the tree', async () => {
    const r = await check({ principal: user('u1'), permission: 'doc:update' }, [editors]);
    expect(r.truth).to.equal('allow');
    const gap = nodes(r.tree, 'gap');
    expect(gap).to.have.length(1);
    expect(gap[0]).to.deep.equal({ label: 'doc:d1#editor is not in the history', truth: 'unknown', source: 'gap', children: [] });
  });

  it('answers unknown, not deny, when the principal is not among the known subjects', async () => {
    const hidden = await check({ principal: user('u1'), permission: 'doc:update' }, [editors], (_o, _r, s) => s.id === 'u1');
    expect(hidden.truth).to.equal('unknown');
    expect(nodes(hidden.tree, 'gap')).to.have.length(1);
    expect((await check({ principal: user('u2'), permission: 'doc:update' }, [editors])).truth).to.equal('unknown');
    expect((await check({ principal: user('u2'), permission: 'doc:update' }, [])).truth).to.equal('deny');
  });

  it('makes an exclusion unknown when the subtracted relation is partial', async () => {
    const banned = GappedSource.key(doc('d1'), 'banned');
    expect((await check({ principal: user('u1') }, [banned])).truth).to.equal('unknown');
    expect((await check({ principal: user('u1') }, [])).truth).to.equal('allow');
  });

  it('lets the known objects of a tupleset decide, and adds the gap under the arrow', async () => {
    const r = await check({ principal: user('u9'), permission: 'folder:read', resource: folder('f1') }, [parents]);
    expect(r.truth).to.equal('allow');
    const hidden = await check({ principal: user('u9'), permission: 'folder:read', resource: folder('f1') }, [parents], (_o, _r, s) => s.type === '$global');
    expect(hidden.truth).to.equal('unknown');
    const arrow = nodes(hidden.tree, 'tupleToUserset');
    expect(arrow).to.have.length(1);
    expect(arrow[0]).to.deep.include({ label: 'parent->admin', truth: 'unknown' });
    expect(arrow[0].children.at(-1)).to.deep.equal({ label: 'folder:f1#parent is not in the history', truth: 'unknown', source: 'gap', children: [] });
  });

  it('reads an unknown column as a gap', async () => {
    expect((await check({ principal: user('u3') }, [folders])).truth).to.equal('unknown');
    expect((await check({ principal: user('u3') }, [])).truth).to.equal('allow');
    expect((await check({ principal: user('u1') }, [folders])).truth).to.equal('allow');
  });

  it('keeps a ceiling over resources unknown when the ancestor walk is partial', async () => {
    const narrowed = { ...user('u1'), ceiling: { resources: [folder('f1')] } };
    expect((await check({ principal: narrowed, permission: 'doc:update' }, [])).truth).to.equal('allow');
    const r = await check({ principal: narrowed, permission: 'doc:update' }, [folders]);
    expect(r.truth).to.equal('unknown');
    expect(nodes(r.tree, 'principal.ceiling')[0]).to.deep.include({ truth: 'unknown' });
    expect((await check({ principal: { ...narrowed, ceiling: { resources: [folder('f2')] } }, permission: 'doc:update' }, [])).truth).to.equal('deny');
    expect((await check({ principal: { ...narrowed, ceiling: { resources: [doc('d1')] } }, permission: 'doc:update' }, [folders])).truth).to.equal('allow');
    expect((await check({ principal: { ...narrowed, ceiling: { resources: [folder('f2')], permissions: ['folder:*'] } }, permission: 'doc:update' }, [folders])).truth).to.equal('deny');
  });
});
