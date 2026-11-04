import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { fingerprintOf, idempotencyKey } from '../src/index.js';

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
