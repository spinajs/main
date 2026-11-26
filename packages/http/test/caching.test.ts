import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { CacheControl, etagMatches, mergeVary } from '../src/index.js';

describe('caching helpers', () => {
  it('merges Vary values once each, keeping the first spelling', () => {
    expect(mergeVary('Origin', ['accept', 'ORIGIN'], undefined, 'Accept, X-Late')).to.deep.eq(['Origin', 'accept', 'X-Late']);
    expect(mergeVary(' , Origin ,', [])).to.deep.eq(['Origin']);
  });

  it('lets * stand for every field', () => {
    expect(mergeVary('Origin', ['*'])).to.deep.eq(['*']);
    expect(mergeVary('*', ['Cookie'])).to.deep.eq(['*']);
  });

  it('matches If-None-Match by the weak comparison', () => {
    expect(etagMatches('"a"', '"a"')).to.eq(true);
    expect(etagMatches('W/"a"', '"a"')).to.eq(true);
    expect(etagMatches('"a"', 'W/"a"')).to.eq(true);
    expect(etagMatches('"b", W/"a"', '"a"')).to.eq(true);
    expect(etagMatches(['"b"', '"a"'], '"a"')).to.eq(true);
    expect(etagMatches('*', '"a"')).to.eq(true);
    expect(etagMatches('"b"', '"a"')).to.eq(false);
    expect(etagMatches(undefined, '"a"')).to.eq(false);
  });

  it('refuses a vary that names no header, or * next to a name', () => {
    for (const vary of [['Accept Language'], [''], ['*', 'Cookie'], 'Cookie', [1]]) {
      expect(() => {
        Reflect.construct(CacheControl, [60, { vary }]);
      }, JSON.stringify(vary)).to.throw(InvalidArgument);
    }
    expect(() => new CacheControl(60, { vary: [] })).to.not.throw();
    expect(() => new CacheControl(60, { vary: ['*'] })).to.not.throw();
  });
});
