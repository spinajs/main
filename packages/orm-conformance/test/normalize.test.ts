import 'mocha';
import { expect } from 'chai';
import { DateTime } from 'luxon';

import { normalizeResult } from '../src/normalize.js';

describe('normalizeResult', () => {
  it('turns dates into ISO UTC, numeric strings into numbers, bigints into strings and bytes into hex', () => {
    const value = {
      at: new Date('2026-06-01T10:00:00.000Z'),
      luxon: DateTime.fromISO('2026-06-01T12:00:00.000+02:00', { setZone: true }),
      price: '12.50',
      count: '3',
      big: 9007199254740993n,
      blob: Buffer.from([1, 2]),
      text: 'Ann',
      none: undefined,
    };

    expect(normalizeResult(value, { order: 'ordered' })).to.deep.equal({
      at: '2026-06-01T10:00:00.000Z',
      big: '9007199254740993',
      blob: '0102',
      count: 3,
      luxon: '2026-06-01T10:00:00.000Z',
      none: null,
      price: 12.5,
      text: 'Ann',
    });
  });

  it('reads 0 and 1 as booleans only under the listed keys', () => {
    expect(normalizeResult([{ Active: 1, Views: 1 }, { Active: 0, Views: 0 }], { order: 'ordered', booleans: ['Active'] })).to.deep.equal([
      { Active: true, Views: 1 },
      { Active: false, Views: 0 },
    ]);
  });

  it('sorts the rows of an unordered result and keeps an ordered one as it is', () => {
    const rows = [{ n: 'b' }, { n: 'a' }];

    expect(normalizeResult(rows, { order: 'unordered' })).to.deep.equal([{ n: 'a' }, { n: 'b' }]);
    expect(normalizeResult(rows, { order: 'ordered' })).to.deep.equal([{ n: 'b' }, { n: 'a' }]);
  });

  it('sorts object keys, so key order never makes two results differ', () => {
    expect(JSON.stringify(normalizeResult({ b: 1, a: 2 }, { order: 'ordered' }))).to.equal('{"a":2,"b":1}');
  });
});
