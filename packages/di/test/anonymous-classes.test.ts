import 'mocha';
import { expect } from 'chai';

import { DI } from '../src/index.js';
import { getTypeName } from '../src/helpers.js';

/**
 * A class expression passed straight as an argument gets no name inference, so `type.name` is
 * `''` - every such class used to share one registry / cache key. Two anonymous classes are two
 * types and must key apart; an instance keys the same as its class.
 */
describe('anonymous classes', () => {
  beforeEach(() => {
    DI.clear();
  });

  const anonymous = () => class {};

  it('getTypeName tells two anonymous classes apart and stays stable per class', () => {
    const a = anonymous();
    const b = anonymous();

    expect(a.name).to.equal('');
    expect(getTypeName(a)).to.not.equal(getTypeName(b));
    expect(getTypeName(a)).to.equal(getTypeName(a));
    expect(getTypeName(new a())).to.equal(getTypeName(a));
  });

  it('keeps a named class on its own name', () => {
    class Named {}
    expect(getTypeName(Named)).to.equal('Named');
    expect(getTypeName(new Named())).to.equal('Named');
  });

  it('resolves two anonymous singletons to their own instances', () => {
    const A = anonymous();
    const B = anonymous();
    DI.register(A).asSelf().singleInstance();
    DI.register(B).asSelf().singleInstance();

    const a = DI.resolve(A);
    const b = DI.resolve(B);

    expect(a).to.be.instanceOf(A);
    expect(b).to.be.instanceOf(B);
    expect(a).to.not.equal(b);
    expect(DI.resolve(A)).to.equal(a);
  });
});
