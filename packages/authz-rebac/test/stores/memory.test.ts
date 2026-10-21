import * as chai from 'chai';
import 'mocha';

import { MemoryTupleStore, objectKey, readTuple, subjectKey, tupleKey } from '../../src/index.js';
import { tupleStoreContract } from '../support/store-contract.js';
import { d1, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

tupleStoreContract('MemoryTupleStore', () => new MemoryTupleStore());

describe('authz-rebac: MemoryTupleStore', () => {
  it('starts with its initial tuples and tells what a write changed', () => {
    const store = new MemoryTupleStore([tuple(d1, 'viewer', user('alice'))]);
    expect(store.has(tuple(d1, 'viewer', user('alice')))).to.equal(true);
    const out = store.writeNow([tuple(d1, 'viewer', user('alice')), tuple(d1, 'viewer', user('bob'))], [tuple(d1, 'owner', user('alice'))], user('admin'));
    expect(out.added).to.deep.equal([tuple(d1, 'viewer', user('bob'))]);
    expect(out.removed).to.deep.equal([]);
  });

  it('bumps its version on every write and tells the listeners', async () => {
    const store = new MemoryTupleStore();
    const seen: string[] = [];
    const off = store.onWrite((v) => seen.push(v));
    const before = store.version();
    await store.write([tuple(d1, 'viewer', user('alice'))], [], user('admin'));
    off();
    await store.write([], [tuple(d1, 'viewer', user('alice'))], user('admin'));
    expect(seen).to.have.length(1);
    expect(store.version()).to.not.equal(before);
  });

  it('hands out copies: changing a read tuple does not change the store', async () => {
    const store = new MemoryTupleStore([tuple(d1, 'viewer', user('alice'))]);
    const [t] = await store.read(d1, 'viewer');
    (t.subject as { id: string }).id = 'mallory';
    expect(await store.read(d1, 'viewer')).to.deep.equal([tuple(d1, 'viewer', user('alice'))]);
  });
});

describe('authz-rebac: keys', () => {
  it('a subject key tells a principal from a subject set, also when an id holds "#" or ":"', () => {
    expect(subjectKey(user('alice'))).to.equal('user:alice');
    expect(subjectKey(set('group', 'eng', 'member'))).to.equal('group:eng#member');
    expect(subjectKey({ type: 'group', id: 'eng#member' })).to.not.equal(subjectKey(set('group', 'eng', 'member')));
    expect(objectKey({ type: 'a:b', id: 'c' })).to.not.equal(objectKey({ type: 'a', id: 'b:c' }));
  });

  it('a tuple key is equal for equal tuples', () => {
    expect(tupleKey(tuple(d1, 'viewer', user('alice')))).to.equal(tupleKey({ object: { id: 'd1', type: 'doc' }, relation: 'viewer', subject: { id: 'alice', type: 'user' } }));
    expect(tupleKey(tuple(d1, 'viewer', user('alice')))).to.not.equal(tupleKey(tuple(d1, 'viewer', user('bob'))));
  });

  it('readTuple copies a well-formed tuple and names what is wrong otherwise', () => {
    expect(readTuple({ object: { type: 'doc', id: 'd1', extra: 1 }, relation: 'viewer', subject: { type: 'user', id: 'alice', authenticated: true } })).to.deep.equal(tuple(d1, 'viewer', user('alice')));
    expect(() => readTuple(null)).to.throw(TypeError, 'tuple must be an object');
    expect(() => readTuple({ object: { type: 'doc' }, relation: 'viewer', subject: user('a') })).to.throw(TypeError, 'tuple.object must name one object');
    expect(() => readTuple({ object: d1, relation: 'a b', subject: user('a') })).to.throw(TypeError, 'tuple.relation must be a relation name');
    expect(() => readTuple({ object: d1, relation: 'viewer', subject: { type: 'user' } })).to.throw(TypeError, 'tuple.subject must be a principal');
    expect(() => readTuple({ object: d1, relation: 'viewer', subject: { object: { type: 'group' }, relation: 'member' } })).to.throw(TypeError, 'tuple.subject must name a subject set');
  });
});
