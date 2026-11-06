import 'mocha';
import { expect } from 'chai';

import { isConstructor, isFactory, getTypeName } from '../src/helpers.js';

describe('isConstructor', () => {
  let probes: unknown[];
  let construct: typeof Reflect.construct;

  beforeEach(() => {
    probes = [];
    construct = Reflect.construct;
    Reflect.construct = ((target: never, args: never, newTarget?: unknown) => {
      probes.push(newTarget);
      return construct(target, args, newTarget as never);
    }) as typeof Reflect.construct;
  });

  afterEach(() => {
    Reflect.construct = construct;
  });

  it('tells constructors from other values', () => {
    class Plain {}
    class Derived extends Plain {}
    function legacy() {}
    const arrow = () => 1;
    const method = { m() {} }.m;
    async function asyncFn() {}
    function* generator() {}

    expect(isConstructor(Plain)).to.equal(true);
    expect(isConstructor(Derived)).to.equal(true);
    expect(isConstructor(legacy)).to.equal(true);
    expect(isConstructor(Plain.bind(null))).to.equal(true);
    expect(isConstructor(new Proxy(Plain, {}))).to.equal(true);
    expect(isConstructor(arrow)).to.equal(false);
    expect(isConstructor(arrow.bind(null))).to.equal(false);
    expect(isConstructor(method)).to.equal(false);
    expect(isConstructor(asyncFn)).to.equal(false);
    expect(isConstructor(generator)).to.equal(false);
    for (const value of [{}, new Plain(), 'Plain', 1, null, undefined, Symbol('s')]) {
      expect(isConstructor(value), String(value)).to.equal(false);
    }
  });

  it('probes a function once, however often it is asked', () => {
    class Service {}
    const factory = () => new Service();

    for (let i = 0; i < 5; i++) {
      expect(isConstructor(Service)).to.equal(true);
      expect(isFactory(factory)).to.equal(true);
    }

    expect(probes.filter((p) => p === Service)).to.have.length(1);
    expect(probes.filter((p) => p === factory)).to.have.length(1);
  });

  it('does not probe a value that is not a function', () => {
    const instance = { constructor: class Named {} };

    expect(getTypeName(instance)).to.equal('Named');
    expect(isConstructor({})).to.equal(false);
    expect(isConstructor('Named')).to.equal(false);

    expect(probes.filter((p) => typeof p !== 'function')).to.deep.equal([]);
  });
});
