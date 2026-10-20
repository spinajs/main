import 'mocha';
import { expect } from 'chai';

import { Class, DI, Injectable, Singleton, TypedArray as OwnTypedArray } from '../src/index.js';

// Stands in for the TypedArray of a second @spinajs/di copy loaded in the same process: same shape, another class.
class TypedArray<R> extends Array<R> {
  constructor(public Type: Class<R> | string) {
    super();
  }
}

const foreignOfType = <T>(type: Class<T>) => new TypedArray<T>(type) as unknown as OwnTypedArray<T>;

describe('a second copy of @spinajs/di in the process', () => {
  afterEach(() => {
    DI.clearCache();
    DI.clearRegistry();
  });

  it('a list built by the other copy collects a type first resolved on its own', () => {
    class Hydrator {}

    @Singleton()
    @Injectable(Hydrator)
    class JsonHydrator extends Hydrator {}

    const single = DI.resolve(JsonHydrator);

    expect(DI.resolve(foreignOfType(Hydrator))).to.deep.equal([single]);
  });

  it('a list built by the other copy caches the collection, not its first element', () => {
    class Source {}

    @Singleton()
    @Injectable(Source)
    class FileSource extends Source {}

    @Singleton()
    @Injectable(Source)
    class DbSource extends Source {}

    const list = DI.resolve(foreignOfType(Source));

    expect(list.map((s) => s.constructor)).to.deep.equal([FileSource, DbSource]);
    expect(DI.resolve(foreignOfType(Source))).to.deep.equal(list);
  });

  it('a second copy does not replace Array.ofType and Array.chainOf once installed', async () => {
    const { ofType, chainOf } = Array;

    // A query string makes the loader evaluate array.ts again, as a second copy would.
    const secondCopy = '../src/array.js?second-copy';
    await import(secondCopy);

    expect(Array.ofType).to.equal(ofType);
    expect(Array.chainOf).to.equal(chainOf);
  });
});
