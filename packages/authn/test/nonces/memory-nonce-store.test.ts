import * as chai from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';

import { NonceStore } from '../../src/contracts/nonce.js';
import { MemoryNonceStore } from '../../src/nonces/index.js';

const expect = chai.expect;

const T0 = Date.parse('2026-06-01T10:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('MemoryNonceStore', () => {
  it('is a NonceStore', () => {
    expect(new MemoryNonceStore()).to.be.instanceOf(NonceStore);
  });

  it('claims a key once while it is live, and again once it expired', async () => {
    const store = new MemoryNonceStore();
    expect(await store.claim('jti:1', at(60), at(0))).to.eq(true);
    expect(await store.claim('jti:1', at(120), at(59))).to.eq(false);
    expect(await store.claim('jti:1', at(120), at(60))).to.eq(true);
    expect(await store.claim('jti:1', at(120), at(61))).to.eq(false);
  });

  it('throws InvalidArgument on a key over 160 code points and on bad dates', async () => {
    const store = new MemoryNonceStore();
    expect(await store.claim('😀'.repeat(160), at(60), at(0))).to.eq(true);
    expect(await rejection(store.claim('k'.repeat(161), at(60), at(0)))).to.be.instanceOf(InvalidArgument);
    expect(await rejection(store.claim('', at(60), at(0)))).to.be.instanceOf(InvalidArgument);
    expect(await rejection(store.claim('x', new Date(NaN), at(0)))).to.be.instanceOf(InvalidArgument);
    expect(await rejection(store.claim('x', new Date(Date.UTC(10000, 0, 1)), at(0)))).to.be.instanceOf(InvalidArgument);
    expect(await rejection(store.claim('x', at(60), 'now' as unknown as Date))).to.be.instanceOf(InvalidArgument);
  });
});
