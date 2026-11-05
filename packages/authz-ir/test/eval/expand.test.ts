import 'mocha';
import { expect } from 'chai';

import { IREvaluator, MemoryTupleSource } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const doc = { type: 'doc', id: 'd1' };

describe('IREvaluator.expand', () => {
  const ir = docsIR();
  ir.types.doc.permissions.first = { priority: [{ when: { computed: 'banned' }, then: 'deny' }, { when: { opaque: 'custom' }, then: 'permit' }] };
  const source = new MemoryTupleSource(ir)
    .add(doc, 'editor', { type: 'user', id: 'u1' })
    .add(doc, 'editor', { type: 'group', id: 'g1', relation: 'member' })
    .setColumn('Doc', 'folder_id', doc, { type: 'folder', id: 'f1' })
    .setColumn('Doc', 'author_id', doc, { type: 'user', id: 'u2' });
  const ev = new IREvaluator(ir, source);

  it('expands a stored relation to its subjects, subject sets included', async () => {
    expect(await ev.expand(doc, 'editor')).to.deep.equal({ kind: 'this', object: doc, relation: 'editor', subjects: [{ type: 'user', id: 'u1' }, { type: 'group', id: 'g1', relation: 'member' }] });
    expect(await ev.expand(doc, 'owner')).to.deep.equal({ kind: 'this', object: doc, relation: 'owner', subjects: [{ type: 'user', id: 'u2' }] });
  });

  it('expands a rewrite one level: computed usersets and tuple-to-userset targets are named', async () => {
    expect(await ev.expand(doc, 'view')).to.deep.equal({
      kind: 'exclusion',
      base: {
        kind: 'union',
        children: [
          { kind: 'computed', object: doc, relation: 'edit' },
          { kind: 'tupleToUserset', object: doc, tupleset: 'parent', computed: [{ object: { type: 'folder', id: 'f1' }, relation: 'view' }] },
        ],
      },
      subtract: { kind: 'computed', object: doc, relation: 'banned' },
    });
    expect(await ev.expand(doc, 'publish')).to.deep.equal({ kind: 'caveat', caveat: 'not_frozen', child: { kind: 'computed', object: doc, relation: 'edit' } });
    expect(await ev.expand(doc, 'first')).to.deep.equal({
      kind: 'priority',
      entries: [
        { when: { kind: 'computed', object: doc, relation: 'banned' }, then: 'deny' },
        { when: { kind: 'opaque', name: 'custom' }, then: 'permit' },
      ],
    });
  });

  it('throws on an unknown relation', async () => {
    let error: unknown;
    try {
      await ev.expand(doc, 'nope');
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(TypeError);
  });
});
