import 'mocha';
import { expect } from 'chai';
import { expectTypeOf } from 'expect-type';

import { DI, token, isToken, getTypeName, Token } from '../src/index.js';

class Greeter {
  public hello() {
    return 'hi';
  }
}

const GREETER = token<Greeter>('__test_greeter__', 'greets');
const PORT = token<number>('__test_port__');

describe('typed tokens', () => {
  beforeEach(() => {
    DI.clear();
  });

  it('builds a token that keeps its key and description', () => {
    expect(GREETER.key).to.eq('__test_greeter__');
    expect(GREETER.description).to.eq('greets');
    expect(isToken(GREETER)).to.be.true;
    expect(isToken('__test_greeter__')).to.be.false;
    expect(isToken(Greeter)).to.be.false;
    expect(isToken(Array.ofType(Greeter))).to.be.false;
  });

  it('types resolve(token) by the token parameter', () => {
    expectTypeOf(DI.resolve(GREETER)).toEqualTypeOf<Greeter>();
    expectTypeOf(DI.resolve(PORT)).toEqualTypeOf<number>();
    expectTypeOf(DI.get(GREETER)).toEqualTypeOf<Greeter | undefined>();
    expectTypeOf(DI.RootContainer.resolve(GREETER, [1])).toEqualTypeOf<Greeter>();
    expectTypeOf(DI.RootContainer.resolveOptional(GREETER)).toEqualTypeOf<Greeter | undefined>();
    expectTypeOf(GREETER).toEqualTypeOf<Token<Greeter>>();
  });

  it('resolves what asToken registered', () => {
    const greeter = new Greeter();
    DI.register(() => greeter).asToken(GREETER);

    const resolved = DI.resolve(GREETER);
    expect(resolved).to.eq(greeter);
    expect(resolved.hello()).to.eq('hi');
  });

  it('asToken is the same registration as as(token.key)', () => {
    DI.register(Greeter).asToken(GREETER);

    expect(DI.resolve('__test_greeter__')).to.be.instanceOf(Greeter);
    expect(DI.check(GREETER)).to.be.true;
    expect(DI.check('__test_greeter__')).to.be.true;
  });

  it('string keys keep working next to tokens', () => {
    DI.register(Greeter).as('__test_greeter__');

    expect(DI.resolve(GREETER)).to.be.instanceOf(Greeter);
    expect(DI.RootContainer.hasRegistered(GREETER)).to.be.true;
  });

  it('passes constructor options through resolve(token, options)', () => {
    class WithOptions {
      constructor(public value: number) {}
    }
    const T = token<WithOptions>('__test_with_options__');
    DI.register(WithOptions).asToken(T);

    expect(DI.resolve(T, [7]).value).to.eq(7);
  });

  it('get(token) returns a value stored under the key and undefined when absent', () => {
    expect(DI.get(PORT)).to.be.undefined;

    DI.register({ v: 1 }).asValue(PORT.key);
    expect(DI.get<{ v: number }>(PORT.key)).to.deep.eq({ v: 1 });
  });

  it('resolveOptional(token) is undefined unless registered', () => {
    expect(DI.RootContainer.resolveOptional(GREETER)).to.be.undefined;

    DI.register(Greeter).asToken(GREETER);
    expect(DI.RootContainer.resolveOptional(GREETER)).to.be.instanceOf(Greeter);
  });

  it('resolves tokens from a child container', () => {
    DI.register(Greeter).asToken(GREETER);

    expect(DI.child().resolve(GREETER)).to.be.instanceOf(Greeter);
  });

  it('getTypeName(token) returns the key', () => {
    expect(getTypeName(GREETER)).to.eq('__test_greeter__');
  });
});
