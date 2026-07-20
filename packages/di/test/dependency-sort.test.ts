import * as chai from 'chai';

import 'mocha';
import { ResolveException, sortByDependencies } from '../src/index.js';

const expect = chai.expect;

interface IItem {
  name: string;
  needs?: string | string[];
}

function sort(items: IItem[]) {
  return sortByDependencies(
    items,
    (i) => i.name,
    (i) => i.needs,
  ).map((i) => i.name);
}

describe('sortByDependencies', () => {
  it('should keep input order of independent items', () => {
    expect(sort([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).to.deep.eq(['a', 'b', 'c']);
  });

  it('should place dependency before dependent regardless of input order', () => {
    expect(sort([{ name: 'temp', needs: 'local' }, { name: 'local' }])).to.deep.eq(['local', 'temp']);
  });

  it('should order chained dependencies', () => {
    expect(sort([{ name: 'a', needs: 'b' }, { name: 'b', needs: 'c' }, { name: 'c' }])).to.deep.eq(['c', 'b', 'a']);
  });

  it('should place all of multiple dependencies before dependent', () => {
    const result = sort([{ name: 'a', needs: ['b', 'c'] }, { name: 'b' }, { name: 'c' }]);

    expect(result.indexOf('b')).to.be.lessThan(result.indexOf('a'));
    expect(result.indexOf('c')).to.be.lessThan(result.indexOf('a'));
  });

  it('should treat undefined, null and empty array dependencies as none', () => {
    const result = sortByDependencies(
      [
        { name: 'a', needs: undefined },
        { name: 'b', needs: null as any },
        { name: 'c', needs: [] },
      ],
      (i) => i.name,
      (i) => i.needs,
    ).map((i) => i.name);

    expect(result).to.deep.eq(['a', 'b', 'c']);
  });

  it('should throw on missing dependency naming both items', () => {
    expect(() => sort([{ name: 'a', needs: 'ghost' }])).to.throw(ResolveException, /'a' depends on 'ghost'/);
  });

  it('should throw on self reference', () => {
    expect(() => sort([{ name: 'a', needs: 'a' }])).to.throw(ResolveException, /'a' depends on itself/);
  });

  it('should throw on circular dependency with cycle path in message', () => {
    expect(() =>
      sort([
        { name: 'a', needs: 'b' },
        { name: 'b', needs: 'a' },
      ]),
    ).to.throw(ResolveException, /'a' -> 'b' -> 'a'/);
  });

  it('should throw on duplicate keys', () => {
    expect(() => sort([{ name: 'a' }, { name: 'a' }])).to.throw(ResolveException, /Duplicate key 'a'/);
  });

  it('should return empty array for empty input', () => {
    expect(sort([])).to.deep.eq([]);
  });

  it('should not report false circular dependency on shared ( diamond ) dependencies', () => {
    // a -> b, a -> c, b -> d, c -> d - d is visited twice but there is no cycle
    const result = sort([
      { name: 'a', needs: ['b', 'c'] },
      { name: 'b', needs: 'd' },
      { name: 'c', needs: 'd' },
      { name: 'd' },
    ]);

    expect(result.indexOf('d')).to.be.lessThan(result.indexOf('b'));
    expect(result.indexOf('d')).to.be.lessThan(result.indexOf('c'));
    expect(result.indexOf('b')).to.be.lessThan(result.indexOf('a'));
    expect(result.indexOf('c')).to.be.lessThan(result.indexOf('a'));
  });
});
