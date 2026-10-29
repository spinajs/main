import { expect } from 'chai';
import { compareCodeUnits } from '../src/index.js';

describe('compareCodeUnits', () => {
  it('orders by UTF-16 code unit, not by locale', () => {
    expect(['foo.ts', 'Foo.ts'].sort(compareCodeUnits)).to.deep.equal(['Foo.ts', 'foo.ts']);
    expect(['ab', 'a_b'].sort(compareCodeUnits)).to.deep.equal(['a_b', 'ab']);
    expect(compareCodeUnits('a', 'a')).to.equal(0);
  });
});
