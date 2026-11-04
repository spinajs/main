import 'mocha';
import { expect } from 'chai';
import { SimRandom, splitmix32 } from '../src/index.js';

const take = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);

describe('SimRandom', () => {
  it('matches the xoshiro128** reference output for the state [1, 2, 3, 4]', () => {
    const r = SimRandom.fromState([1, 2, 3, 4]);
    expect(take(10, () => r.nextUint32())).to.deep.equal([11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804]);
  });

  it('expands a seed into four state words with splitmix32', () => {
    const words = splitmix32(1);
    expect(take(4, words)).to.deep.equal([0x96a0f96b, 0x12bc8390, 0x971e9964, 0x79adc7e7]);
  });

  it('produces the golden sequences of seeds 1 and 42', () => {
    const one = new SimRandom(1);
    const answer = new SimRandom(42);
    expect(take(5, () => one.nextUint32())).to.deep.equal([2442144158, 3238099751, 3819917871, 2104621829, 2021136066]);
    expect(take(5, () => answer.nextUint32())).to.deep.equal([2837322924, 544945897, 479756282, 3500138142, 339756180]);
  });

  it('maps outputs to [0, 1), to bounded integers and to picks', () => {
    expect(new SimRandom(1).next()).to.equal(0.5686059962026775);
    const zero = new SimRandom(0);
    expect(take(10, () => zero.int(10))).to.deep.equal([8, 2, 0, 6, 0, 5, 0, 3, 6, 0]);
    const seven = new SimRandom(7);
    expect(take(6, () => seven.pick(['a', 'b', 'c']))).to.deep.equal(['a', 'b', 'b', 'a', 'b', 'b']);
  });

  it('gives two generators of one seed the same stream', () => {
    const a = new SimRandom(123);
    const b = new SimRandom(123);
    expect(take(50, () => a.next())).to.deep.equal(take(50, () => b.next()));
  });

  it('rejects a bound below 1 and an empty pick', () => {
    const r = new SimRandom(1);
    expect(() => r.int(0)).to.throw(RangeError);
    expect(() => r.int(2.5)).to.throw(RangeError);
    expect(() => r.pick([])).to.throw(RangeError);
  });
});
