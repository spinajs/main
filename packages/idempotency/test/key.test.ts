import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { fingerprintOf, idempotencyKey, isRandomKey } from '../src/index.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('idempotencyKey', () => {
  it('is the sha256 hex of the JSON text [namespace, principal, key]', () => {
    expect(idempotencyKey({ namespace: 'http:POST /orders', principal: 'user:7' }, 'k-1')).to.equal(sha256('["http:POST /orders","user:7","k-1"]'));
  });

  it('writes a missing principal as null, apart from an empty one', () => {
    expect(idempotencyKey({ namespace: 'queue:x' }, 'm')).to.equal(sha256('["queue:x",null,"m"]'));
    expect(idempotencyKey({ namespace: 'queue:x' }, 'm')).to.not.equal(idempotencyKey({ namespace: 'queue:x', principal: '' }, 'm'));
  });

  it('keeps the parts apart where plain concatenation would join them', () => {
    expect(idempotencyKey({ namespace: 'ab', principal: 'c' }, 'k')).to.not.equal(idempotencyKey({ namespace: 'a', principal: 'bc' }, 'k'));
  });
});

describe('fingerprintOf', () => {
  it('hashes bytes and text alike', () => {
    expect(fingerprintOf(Buffer.from('{"n":1}'))).to.equal(fingerprintOf('{"n":1}'));
    expect(fingerprintOf('')).to.equal('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('isRandomKey', () => {
  it('accepts a UUID v4 or v7 in either case', () => {
    expect(isRandomKey('3b241101-e2bb-4255-8caf-4136c566a962')).to.eq(true);
    expect(isRandomKey('3B241101-E2BB-4255-8CAF-4136C566A962')).to.eq(true);
    expect(isRandomKey('01932c07-209c-7a3b-9f2e-8d4c6b1a0e5f')).to.eq(true);
    expect(isRandomKey('01932C07-209C-7A3B-9F2E-8D4C6B1A0E5F')).to.eq(true);
  });

  it('rejects guessable or non-UUID keys', () => {
    expect(isRandomKey('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).to.eq(false);
    expect(isRandomKey('2ed6657d-e927-568b-95e1-2665a8aea6a2')).to.eq(false);
    expect(isRandomKey('00000000-0000-0000-0000-000000000000')).to.eq(false);
    expect(isRandomKey('{3b241101-e2bb-4255-8caf-4136c566a962}')).to.eq(false);
    expect(isRandomKey('order-123')).to.eq(false);
    expect(isRandomKey('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).to.eq(false);
  });
});
