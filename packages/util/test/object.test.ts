import { expect } from 'chai';
import { isPlainObject, deepFreeze, frozenCopy, isNonEmptyString } from '../src/index.js';

describe('object helpers', () => {
  it('isPlainObject accepts objects, rejects null and arrays', () => {
    expect(isPlainObject({})).to.be.true;
    expect(isPlainObject(null)).to.be.false;
    expect(isPlainObject([])).to.be.false;
    expect(isPlainObject('x')).to.be.false;
  });
  it('isNonEmptyString', () => {
    expect(isNonEmptyString('a')).to.be.true;
    expect(isNonEmptyString('')).to.be.false;
    expect(isNonEmptyString(1)).to.be.false;
  });
  it('deepFreeze freezes nested values in place', () => {
    const v = { a: { b: [1] } };
    expect(deepFreeze(v)).to.equal(v);
    expect(Object.isFrozen(v.a.b)).to.be.true;
  });
  it('frozenCopy clones dates and leaves the source mutable', () => {
    const at = new Date(0);
    const src = { at, list: [{ x: 1 }] };
    const out = frozenCopy(src);
    expect(out).to.not.equal(src);
    expect(out.at).to.not.equal(at);
    expect(out.at.getTime()).to.equal(0);
    expect(Object.isFrozen(out.list[0])).to.be.true;
    expect(Object.isFrozen(src)).to.be.false;
  });
  it('frozenCopy cuts values deeper than maxDepth', () => {
    expect(frozenCopy({ a: { b: 1 } }, 0)).to.deep.equal({ a: undefined });
  });
});
