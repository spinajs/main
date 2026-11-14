import 'mocha';
import { expect } from 'chai';

import { GLOBAL_OBJECT, IREvaluator, IRLimitExceeded, MemoryTupleSource } from '../../src/index.js';
import type { PolicyIR } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const user = (id: string) => ({ type: 'user', id });
const doc = (id: string) => ({ type: 'doc', id });
const folder = (id: string) => ({ type: 'folder', id });
const group = (id: string) => ({ type: 'group', id });

function world(ir: PolicyIR = docsIR()): MemoryTupleSource {
  return new MemoryTupleSource(ir)
    .add(folder('f1'), 'parent', GLOBAL_OBJECT)
    .add(folder('f2'), 'parent', GLOBAL_OBJECT)
    .add(folder('f1'), 'viewer', { type: 'group', id: 'g1', relation: 'member' })
    .add(group('g1'), 'member', user('u3'))
    .add(folder('f2'), 'viewer', { type: 'user', id: '*' })
    .add(doc('d1'), 'editor', user('u1'))
    .add(doc('d3'), 'banned', user('u3'))
    .add(GLOBAL_OBJECT, 'admin', user('u9'))
    .setColumn('Doc', 'folder_id', doc('d1'), folder('f1'))
    .setColumn('Doc', 'folder_id', doc('d2'), folder('f2'))
    .setColumn('Doc', 'folder_id', doc('d3'), folder('f1'))
    .setColumn('Doc', 'author_id', doc('d4'), user('u1'));
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const ids = (refs: ReadonlyArray<{ id: string }>): string[] => refs.map((r) => r.id);

describe('IREvaluator.listObjects', () => {
  const ev = new IREvaluator(docsIR(), world());

  it('lists the objects a check allows, through tuples, columns, groups, the wildcard and $global', async () => {
    expect(ids(await collect(ev.listObjects({ principal: user('u1'), permission: 'doc:read', type: 'doc' })))).to.deep.equal(['d1', 'd2', 'd4']);
    expect(ids(await collect(ev.listObjects({ principal: user('u3'), permission: 'doc:read', type: 'doc' })))).to.deep.equal(['d1', 'd2']);
    expect(ids(await collect(ev.listObjects({ principal: user('u9'), permission: 'doc:read', type: 'doc' })))).to.deep.equal(['d1', 'd2', 'd3']);
    expect(ids(await collect(ev.listObjects({ principal: user('u9'), permission: 'folder:read', type: 'folder' })))).to.deep.equal(['f1', 'f2']);
  });

  it('lists nothing for a permission bound to another type', async () => {
    expect(await collect(ev.listObjects({ principal: user('u1'), permission: 'folder:read', type: 'doc' }))).to.deep.equal([]);
  });

  it('applies the caveat context and the principal narrowing to every candidate', async () => {
    expect(ids(await collect(ev.listObjects({ principal: user('u1'), permission: 'doc:publish', type: 'doc', context: { resource: { status: 'draft' } } })))).to.deep.equal(['d1', 'd4']);
    expect(await collect(ev.listObjects({ principal: user('u1'), permission: 'doc:publish', type: 'doc' }))).to.deep.equal([]);
    expect(ids(await collect(ev.listObjects({ principal: { ...user('u9'), ceiling: { resources: [folder('f2')] } }, permission: 'doc:read', type: 'doc' })))).to.deep.equal(['d2']);
  });

  it('stops past maxCalls', async () => {
    const small = new IREvaluator(docsIR(), world(), { maxCalls: 2 });
    let error: unknown;
    try {
      await collect(small.listObjects({ principal: user('u9'), permission: 'doc:read', type: 'doc' }));
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(IRLimitExceeded);
  });
});

describe('IREvaluator.listSubjects', () => {
  const ev = new IREvaluator(docsIR(), world());

  it('lists the subjects of a type that a check allows, the wildcard included', async () => {
    expect(ids(await collect(ev.listSubjects(doc('d1'), 'doc:read', 'user')))).to.deep.equal(['u1', 'u3', 'u9']);
    expect(ids(await collect(ev.listSubjects(doc('d3'), 'doc:read', 'user')))).to.deep.equal(['u9']);
    expect(ids(await collect(ev.listSubjects(doc('d2'), 'doc:read', 'user')))).to.deep.equal(['*', 'u9']);
    expect(ids(await collect(ev.listSubjects(doc('d1'), 'doc:update', 'user')))).to.deep.equal(['u1']);
    expect(await collect(ev.listSubjects(doc('d1'), 'doc:read', 'group'))).to.deep.equal([]);
  });
});
