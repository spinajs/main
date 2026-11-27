import { expect } from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';
import { anyTag, bulkTag, cacheKey, hashKey, parseDuration, partTag, rowTag } from '../src/index.js';

describe('keys, tags and durations', () => {
  it('builds a store key that no cache name or segment can forge', () => {
    expect(cacheKey('default', 'k', [])).to.eq('default//k');
    expect(cacheKey('a', 'k', ['t/1', 'x'])).to.eq('a/t%2F1/x//k');
    expect(cacheKey('a', 'k', ['b/c'])).to.not.eq(cacheKey('a', 'k', ['b', 'c']));
    expect(cacheKey('a/b', 'k', [])).to.not.eq(cacheKey('a', 'k', ['b']));
    expect(cacheKey('a', 'k', ['', 'x'])).to.not.eq(cacheKey('a', 'x//k', []));
  });

  it('hashes key parts to a stable short key', () => {
    const parts = ['default', 'select * from t where id = ?', [1, new Date(0)]];
    expect(hashKey(parts)).to.eq(hashKey(['default', 'select * from t where id = ?', [1, new Date(0)]]));
    expect(hashKey(parts)).to.not.eq(hashKey(['default', 'select * from t where id = ?', [2, new Date(0)]]));
    expect(hashKey(parts)).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(() => hashKey([() => 1])).to.throw(InvalidArgument);
  });

  it('writes the four tag kinds of a table from the texts it is given', () => {
    expect(rowTag('invoice', '17')).to.eq('row:invoice:17');
    expect(rowTag('tag_pair', '["1","a"]')).to.eq('row:tag_pair:["1","a"]');
    expect(partTag('invoice', 'customer_id', '5')).to.eq('part:invoice:customer_id=5');
    expect(anyTag('invoice')).to.eq('any:invoice');
    expect(bulkTag('invoice')).to.eq('bulk:invoice');
  });

  it('parses durations and milliseconds', () => {
    expect([parseDuration('5m'), parseDuration('1h'), parseDuration('250ms'), parseDuration(' 2 s '), parseDuration(1500)]).to.deep.eq([300_000, 3_600_000, 250, 2000, 1500]);
    expect(() => parseDuration('soon', 'ttl')).to.throw(InvalidArgument, 'ttl');
    expect(() => parseDuration(-1)).to.throw(InvalidArgument);
  });
});
