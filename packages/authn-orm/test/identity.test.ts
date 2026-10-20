import { InvalidArgument } from '@spinajs/exceptions';
import { expect } from 'chai';
import 'mocha';

import { identityKey, parseIdentityKey } from '../src/index.js';

describe('identityKey / parseIdentityKey (D1)', () => {
  it('joins type and id with a colon', () => {
    expect(identityKey({ type: 'user', id: '3f2b6c1e-0000-4000-8000-000000000001' })).to.eq('user:3f2b6c1e-0000-4000-8000-000000000001');
    expect(identityKey({ type: 'key', id: 'k1' })).to.eq('key:k1');
  });

  it('keeps colons in the id', () => {
    expect(identityKey({ type: 'service', id: 'a:b:c' })).to.eq('service:a:b:c');
  });

  it('throws on an empty type or a colon in the type', () => {
    expect(() => identityKey({ type: '', id: 'u1' })).to.throw(InvalidArgument);
    expect(() => identityKey({ type: 'us:er', id: 'u1' })).to.throw(InvalidArgument);
  });

  it('throws instead of truncating a key over the column width', () => {
    expect(identityKey({ type: 'user', id: 'x'.repeat(95) })).to.have.length(100);
    expect(() => identityKey({ type: 'user', id: 'x'.repeat(96) })).to.throw(InvalidArgument);
  });

  it('takes the column width as a parameter', () => {
    expect(identityKey({ type: 'user', id: 'abcdef' }, 11)).to.eq('user:abcdef');
    expect(() => identityKey({ type: 'user', id: 'abcdefg' }, 11)).to.throw(InvalidArgument);
  });

  it('parses at the first colon', () => {
    expect(parseIdentityKey('user:u1')).to.deep.eq({ type: 'user', id: 'u1' });
    expect(parseIdentityKey('service:a:b')).to.deep.eq({ type: 'service', id: 'a:b' });
    expect(parseIdentityKey('user:')).to.deep.eq({ type: 'user', id: '' });
  });

  it('round-trips', () => {
    const ref = { type: 'key', id: 'kid:with:colons' };
    expect(parseIdentityKey(identityKey(ref))).to.deep.eq(ref);
  });

  it('refuses a value without a colon or with an empty type', () => {
    expect(() => parseIdentityKey('user')).to.throw(InvalidArgument);
    expect(() => parseIdentityKey(':u1')).to.throw(InvalidArgument);
    expect(() => parseIdentityKey('')).to.throw(InvalidArgument);
  });
});
