import { expect } from 'chai';
import 'mocha';
import { CacheValueNotSerializable, decodeValue, encodeValue } from '../src/index.js';

class Money {
  constructor(public readonly cents: number) {}
}

describe('cache values', () => {
  it('round-trips raw rows exactly: Date, Buffer, BigInt, Map, Set, undefined', () => {
    const row = { at: new Date(0), blob: Buffer.from('ab'), big: 10n, tags: new Set(['x']), map: new Map([['k', 1]]), none: undefined, list: [1, 'a', null] };
    const back = decodeValue<typeof row>(encodeValue(row));
    expect(back).to.deep.eq(row);
    expect(Buffer.isBuffer(back.blob)).to.eq(true);
    expect(back).to.not.eq(row);
  });

  it('refuses a value it would not give back as it was, naming where', () => {
    expect(() => encodeValue({ fn: () => 1 })).to.throw(CacheValueNotSerializable, '$.fn');
    expect(() => encodeValue({ price: new Money(5) })).to.throw(CacheValueNotSerializable, 'Money');
    expect(() => encodeValue([Symbol('s')])).to.throw(CacheValueNotSerializable, '$.0');
    expect(() => encodeValue(new Map([['k', new Money(1)]]))).to.throw(CacheValueNotSerializable);
  });

  it('throws on bytes that are not a stored value', () => {
    expect(() => decodeValue(new Uint8Array([1, 2, 3]))).to.throw();
  });
});
