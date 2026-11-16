import * as chai from 'chai';
import 'mocha';

import { CAVEAT_CONTEXT_MAX, caveatKey, readTuple, sameCaveat, tupleKey } from '../src/keys.js';
import { d1, tuple, user } from './support/world.js';

const expect = chai.expect;

describe('authz-rebac: caveated tuple keys', () => {
  it('reads a caveat as a canonical copy and omits an empty context', () => {
    const t = readTuple({ ...tuple(d1, 'viewer', user('bob')), caveat: { name: 'not_expired', context: { 'env.until': 20, 'env.a': 'x' } } });
    expect(Object.keys(t.caveat!.context!)).to.deep.equal(['env.a', 'env.until']);
    expect(readTuple({ ...tuple(d1, 'viewer', user('bob')), caveat: { name: 'c', context: {} } }).caveat).to.deep.equal({ name: 'c' });
    expect(readTuple(tuple(d1, 'viewer', user('bob')))).to.not.have.property('caveat');
  });

  it('refuses a malformed caveat, an unsafe path or an oversized context', () => {
    const t = tuple(d1, 'viewer', user('bob'));
    expect(() => readTuple({ ...t, caveat: { name: 'bad name' } })).to.throw(TypeError, '.caveat.name');
    expect(() => readTuple({ ...t, caveat: { name: 'c', extra: 1 } })).to.throw(TypeError, '.caveat');
    expect(() => readTuple({ ...t, caveat: { name: 'c', context: { 'env.__proto__.x': 1 } } })).to.throw(TypeError, 'context');
    expect(() => readTuple({ ...t, caveat: { name: 'c', context: { 'env.o': { nested: 1 } } } })).to.throw(TypeError, 'context');
    expect(() => readTuple({ ...t, caveat: { name: 'c', context: { 'env.big': 'x'.repeat(CAVEAT_CONTEXT_MAX) } } })).to.throw(TypeError, `${CAVEAT_CONTEXT_MAX}`);
  });

  it('keeps the caveat out of the tuple identity; caveatKey ignores context key order', () => {
    const t = tuple(d1, 'viewer', user('bob'));
    expect(tupleKey({ ...t, caveat: { name: 'c' } })).to.equal(tupleKey(t));
    expect(caveatKey({ name: 'c', context: { 'env.a': 1, 'env.b': 2 } })).to.equal(caveatKey({ name: 'c', context: { 'env.b': 2, 'env.a': 1 } }));
    expect(caveatKey({ name: 'c' })).to.equal(caveatKey({ name: 'c', context: {} }));
    expect(sameCaveat(undefined, undefined)).to.equal(true);
    expect(sameCaveat({ name: 'c' }, undefined)).to.equal(false);
    expect(sameCaveat({ name: 'c', context: { 'env.a': 1 } }, { name: 'c', context: { 'env.a': 2 } })).to.equal(false);
  });
});
